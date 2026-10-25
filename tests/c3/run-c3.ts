/**
 * Preuve C3 sur AWS, de bout en bout, à travers CloudFront :
 *   rédacteur (WebSocket) écrit → lien → clic (202) → rappels avec le ticket → 200 →
 *   téléchargement du PDF par l'URL pré-signée.
 * Vérifie : PDF valide, séquence du PDF ≥ dernière modification confirmée avant le
 * clic, PDF préparé dès la création du lien (premier clic sans écriture → 200).
 *
 *   npm run test:c3 -- --base-url https://xxx.cloudfront.net
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { parseArgs } from "node:util";
import { TestWriter } from "../helpers/realtime.ts";

const { values } = parseArgs({ options: { "base-url": { type: "string" } } });

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any>, headers: response.headers };
}

async function main() {
  const base = values["base-url"]?.replace(/\/$/, "");
  if (!base) throw new Error("--base-url requis (sortie Url du déploiement)");
  setDefaultAutoSelectFamilyAttemptTimeout(5000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const steps: Record<string, unknown> = {};

  const session = await post(base, "/api/session", { name: "C3", email: `c3-${stamp.toLowerCase()}@test.local` });
  const auth = { authorization: `Bearer ${session.json.token}` };
  const docId = (await post(base, "/api/documents", { title: `C3 ${stamp}` }, auth)).json.docId as string;

  const writer = new TestWriter(`${base.replace(/^http/, "ws")}/collab`, docId, session.json.token);
  await writer.synced(30_000);
  writer.insert(0, "Premier jet. ");
  await writer.idle();

  // 1. Lien créé : PDF préparé ; un clic sans nouvelle écriture doit finir en 200 vite.
  const linkA = (await post(base, `/api/documents/${docId}/links`, { max: 5 }, auth)).json;
  const t0 = Date.now();
  let prepared = await post(base, linkA.claimPath, {});
  const ticketA = prepared.headers.getSetCookie().find((c) => c.startsWith("ticket="))?.split(";")[0];
  while (prepared.status === 202) {
    await new Promise((r) => setTimeout(r, 500));
    prepared = await post(base, linkA.claimPath, {}, { cookie: ticketA! });
  }
  steps.preparation = { status: prepared.status, ms: Date.now() - t0 };

  // 2. Modification confirmée, puis clic : le PDF doit la contenir (seq ≥ dernier ack).
  writer.insert(writer.text.length, "Ajout juste avant le clic.");
  await writer.idle();
  const lastAck = writer.acks.at(-1)!;
  const linkB = (await post(base, `/api/documents/${docId}/links`, { max: 5 }, auth)).json;
  writer.insert(writer.text.length, " Ajout après le clic.");
  const t1 = Date.now();
  let click = await post(base, linkB.claimPath, {});
  const first = click.status;
  const ticketB = click.headers.getSetCookie().find((c) => c.startsWith("ticket="))?.split(";")[0];
  let polls = 0;
  while (click.status === 202) {
    await new Promise((r) => setTimeout(r, (Number(click.json.retryAfter) || 2) * 1000));
    click = await post(base, linkB.claimPath, {}, { cookie: ticketB! });
    polls++;
  }
  const url = click.json.url as string;
  const pdfSeq = Number(new URL(url).pathname.match(/\/(\d+)\.pdf$/)![1]);
  const pdf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const header = Buffer.from(pdf.subarray(0, 5)).toString();
  const subject = Buffer.from(pdf).toString("latin1").match(/\(seq (\d+)\)/)?.[1];
  steps.clic = { premierStatut: first, rappels: polls, msJusqua200: Date.now() - t1, lastAck, pdfSeq, taille: pdf.length, header, subject };
  writer.destroy();

  const ok =
    prepared.status === 200 &&
    click.status === 200 &&
    header === "%PDF-" &&
    pdfSeq >= lastAck &&
    Number(subject) === pdfSeq;
  const result = { target: "aws", startedAt: new Date(t0).toISOString(), docId, ...steps, ok };
  mkdirSync("tests/results/c3", { recursive: true });
  const file = `tests/results/c3/${stamp}-aws.json`;
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  console.log(`résultats bruts : ${file} → ${ok ? "OK" : "ÉCHEC"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
