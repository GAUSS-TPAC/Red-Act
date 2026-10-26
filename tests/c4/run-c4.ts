/**
 * Mesure C4 sur AWS : un même e-mail sur 3 appareils (2 sur le document A, 1 sur le
 * document B) envoie des blocs de 700 caractères en rafale jusqu'au refus. Le total
 * accepté (relu en base + S3) doit être ≤ 10 000 et égal au crédit consommé.
 * (En local, C4 est couvert par les tests Vitest de tests/c2.)
 *
 *   node scripts/run-ts.mjs tests/c4/run-c4.ts --base-url https://xxx.cloudfront.net --bucket <BucketName>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { parseArgs } from "node:util";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { creditKey, DAILY_CREDIT, TABLES, TEXT_NAME } from "@editeur/shared";
import { s3BlobStore, createDocumentClient } from "../../packages/realtime/src/aws.ts";
import { loadDocument } from "../../packages/realtime/src/store.ts";
import { TestWriter, waitFor } from "../helpers/realtime.ts";

const { values } = parseArgs({ options: { "base-url": { type: "string" }, bucket: { type: "string" } } });

async function api(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${path} : ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const base = values["base-url"]?.replace(/\/$/, "");
  if (!base || !values.bucket) throw new Error("usage : run-c4.ts --base-url https://xxx.cloudfront.net --bucket <BucketName>");
  setDefaultAutoSelectFamilyAttemptTimeout(5000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const email = `c4-${stamp.toLowerCase()}@test.local`;
  const token = (await api(base, "/api/session", { name: "C4", email })).token as string;
  const docA = (await api(base, "/api/documents", { title: `C4 A ${stamp}` }, token)).docId as string;
  const docB = (await api(base, "/api/documents", { title: `C4 B ${stamp}` }, token)).docId as string;
  const url = `${base.replace(/^http/, "ws")}/collab`;
  const devices = [docA, docA, docB].map((d) => new TestWriter(url, d, token));
  await Promise.all(devices.map((d) => d.synced(30_000)));

  const chunk = "x".repeat(700);
  let sentChars = 0;
  // Rafale : un bloc toutes les 50 ms par appareil, sans attendre la confirmation.
  await Promise.all(
    devices.map(async (d) => {
      const deadline = Date.now() + 60_000;
      while (d.refusal === undefined && d.closedReason === undefined && Date.now() < deadline) {
        d.insert(d.text.length, chunk);
        sentChars += chunk.length;
        await new Promise((r) => setTimeout(r, 50));
      }
    }),
  );
  await waitFor(() => devices.every((d) => d.refusal !== undefined || d.closedReason !== undefined), 30_000, "refus").catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  const db = createDocumentClient();
  const blobs = s3BlobStore(values.bucket);
  const lenA = (await loadDocument(db, blobs, docA))!.doc.getText(TEXT_NAME).length;
  const lenB = (await loadDocument(db, blobs, docB))!.doc.getText(TEXT_NAME).length;
  const credit = (await db.send(new GetCommand({ TableName: TABLES.credits.tableName, Key: { pk: creditKey(email) }, ConsistentRead: true })))
    .Item;
  const total = lenA + lenB;
  const result = {
    target: "aws",
    variante: "3 appareils (2 sur A, 1 sur B), rafale 700 car./50 ms sans attendre",
    email,
    sentChars,
    acceptedA: lenA,
    acceptedB: lenB,
    totalAccepted: total,
    creditUsed: credit?.used ?? null,
    refusals: devices.map((d) => d.refusal?.code ?? d.closedReason ?? null),
    ok: total <= DAILY_CREDIT && credit?.used === total,
  };
  for (const d of devices) d.destroy();
  mkdirSync("tests/results/c4", { recursive: true });
  const file = `tests/results/c4/${stamp}-aws.json`;
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  console.log(`résultats bruts : ${file} → ${result.ok ? "OK" : "ÉCHEC"}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
