// C2 et C4 en local : vrais clients Hocuspocus, serveur temps réel, DynamoDB Local.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditKey, DAILY_CREDIT, REFUSAL, TABLES, TEXT_NAME } from "@editeur/shared";
import { createDocumentClient } from "../../packages/api/src/aws.ts";
import { loadDocument } from "../../packages/realtime/src/store.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";
import { createDocument, startRealtime, TestWriter, testToken, waitFor } from "../helpers/realtime.ts";
import { checkConvergence } from "./convergence.ts";

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

describe.skipIf(!dbUp)("C2 — rien de perdu, tous convergent (DynamoDB Local)", () => {
  let rt: Awaited<ReturnType<typeof startRealtime>>;
  const writers: TestWriter[] = [];

  beforeAll(async () => {
    await ensureLocalTables();
    rt = await startRealtime(db);
  });
  afterAll(async () => {
    for (const w of writers) w.destroy();
    await rt.server.destroy();
  });

  const connect = async (docId: string, email: string) => {
    const writer = new TestWriter(rt.url, docId, testToken(email));
    writers.push(writer);
    await writer.synced();
    return writer;
  };

  it("20 rédacteurs écrivent au même endroit en même temps", async () => {
    const emails = Array.from({ length: 20 }, (_, i) => `r${i}@c2.local`);
    const docId = await createDocument(db, emails);
    const clients = await Promise.all(emails.map((e) => connect(docId, e)));

    // 10 tours : chacun insère au début du texte, sans attendre les autres.
    for (let round = 0; round < 10; round++) {
      clients.forEach((c, i) => c.insert(0, `[${i}.${round}]`));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await Promise.all(clients.map((c) => c.idle()));

    const report = await checkConvergence(db, rt.blobs, docId, clients);
    expect(report.identicalTexts).toBe(true);
    expect(report.identicalStateVectors).toBe(true);
    expect(report.persistedMatches).toBe(true);
    expect(report.missingAckedSeqs).toEqual([]);
    expect(report.length).toBe(clients.reduce((n, _, i) => n + Array.from({ length: 10 }, (_, r) => `[${i}.${r}]`).join("").length, 0));
    expect(clients.every((c) => c.refusal === undefined)).toBe(true);
  });

  it("un nouveau client reçoit l'état complet ; le serveur relit tout depuis la base", async () => {
    const docId = await createDocument(db, ["a@c2.local", "b@c2.local"]);
    const a = await connect(docId, "a@c2.local");
    a.insert(0, "premier");
    await a.idle();
    const b = await connect(docId, "b@c2.local");
    await waitFor(() => b.text.toString() === "premier", 5_000, "état initial");
    const loaded = await loadDocument(db, rt.blobs, docId);
    expect(loaded!.doc.getText(TEXT_NAME).toString()).toBe("premier");
  });

  it("refuse un contenu qui n'est pas du texte (4400) et ne l'écrit pas", async () => {
    const docId = await createDocument(db, ["intrus@c2.local"]);
    const w = await connect(docId, "intrus@c2.local");
    w.doc.getMap("autre").set("x", "contournement du crédit");
    await waitFor(() => w.refusal !== undefined, 5_000, "refus");
    expect(w.refusal?.code).toBe(REFUSAL.contenuInvalide.code);
    const loaded = await loadDocument(db, rt.blobs, docId);
    expect(loaded!.seq).toBe(0);
  });

  it("refuse la connexion à un non-éditeur", async () => {
    const docId = await createDocument(db, ["proprio@c2.local"]);
    const w = new TestWriter(rt.url, docId, testToken("autre@c2.local"));
    writers.push(w);
    let failed = false;
    w.provider.on("authenticationFailed", () => (failed = true));
    await waitFor(() => failed, 5_000, "refus d'authentification");
  });

  it("compaction au départ du dernier client : instantané + pointeur, rechargement identique", async () => {
    const docId = await createDocument(db, ["c@c2.local"]);
    const w = await connect(docId, "c@c2.local");
    for (let i = 0; i < 5; i++) w.insert(w.text.length, `ligne ${i}\n`);
    await w.idle();
    const expected = w.text.toString();
    w.destroy();
    await waitFor(() => !rt.open.has(docId), 5_000, "déchargement");
    const item = (await db.send(new GetCommand({ TableName: TABLES.documents.tableName, Key: { docId } }))).Item!;
    expect(item.snapshotSeq).toBe(item.seq);
    expect(rt.blobs.blobs.has(item.snapshotKey)).toBe(true);
    const loaded = await loadDocument(db, rt.blobs, docId);
    expect(loaded!.doc.getText(TEXT_NAME).toString()).toBe(expected);
  });
});

describe.skipIf(!dbUp)("C4 — jamais plus que le crédit du jour, même depuis deux appareils", () => {
  let rt: Awaited<ReturnType<typeof startRealtime>>;
  const writers: TestWriter[] = [];

  beforeAll(async () => {
    await ensureLocalTables();
    rt = await startRealtime(db);
  });
  afterAll(async () => {
    for (const w of writers) w.destroy();
    await rt.server.destroy();
  });

  it("un même e-mail sur deux connexions (deux documents) : total accepté ≤ 10 000", async () => {
    const email = `c4-${Date.now()}@c4.local`;
    const docs = [await createDocument(db, [email]), await createDocument(db, [email])];
    const devices = await Promise.all(
      docs.map(async (docId) => {
        const w = new TestWriter(rt.url, docId, testToken(email));
        writers.push(w);
        await w.synced();
        return w;
      }),
    );

    // Chaque appareil envoie des blocs de 700 caractères jusqu'au refus.
    const chunk = "x".repeat(700);
    await Promise.all(
      devices.map(async (d) => {
        while (d.refusal === undefined) {
          d.insert(d.text.length, chunk);
          await d.idle();
        }
      }),
    );

    for (const d of devices) {
      expect(d.refusal?.code).toBe(REFUSAL.creditEpuise.code);
      expect(d.refusal?.finLe).toBeGreaterThan(Date.now());
    }
    const accepted = await Promise.all(
      docs.map(async (docId) => (await loadDocument(db, rt.blobs, docId))!.doc.getText(TEXT_NAME).length),
    );
    const total = accepted[0]! + accepted[1]!;
    const credit = (
      await db.send(new GetCommand({ TableName: TABLES.credits.tableName, Key: { pk: creditKey(email) }, ConsistentRead: true }))
    ).Item!;
    expect(total).toBeLessThanOrEqual(DAILY_CREDIT);
    expect(credit.used).toBe(total);
    expect(total).toBeGreaterThan(DAILY_CREDIT - 700); // tout le crédit utilisable a été accepté
    expect(rt.refusals.filter((r) => r.writer === email).length).toBeGreaterThanOrEqual(2);
  });
});
