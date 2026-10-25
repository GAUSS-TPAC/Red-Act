// Anti-abus des rédacteurs : 5 refus en 1 min → blocage 5 h, refus 4003 ; présence.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFUSAL, TABLES } from "@editeur/shared";
import { WRITER_BLOCK_MS, WriterGuard } from "../src/abuse.ts";
import { createDocumentClient } from "../src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../../scripts/local-tables.ts";
import { createDocument, startRealtime, TestWriter, testToken, waitFor } from "../../../tests/helpers/realtime.ts";

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

describe.skipIf(!dbUp)("anti-abus rédacteurs (DynamoDB Local)", () => {
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

  it("WriterGuard : 5 refus en 1 min bloquent 5 h ; 4 refus espacés non", async () => {
    let clock = Date.parse("2026-11-01T10:00:00Z");
    const guard = new WriterGuard(db, () => clock);
    const lent = `lent-${Date.now()}@abus.local`;
    for (let i = 0; i < 6; i++) {
      expect(await guard.record(lent)).toBeUndefined();
      clock += 15_000; // 4 par minute au plus
    }
    const rapide = `rapide-${Date.now()}@abus.local`;
    for (let i = 0; i < 4; i++) expect(await guard.record(rapide)).toBeUndefined();
    expect(await guard.record(rapide)).toBe(clock + WRITER_BLOCK_MS);
    expect(guard.blocked(rapide)).toBe(clock + WRITER_BLOCK_MS);
    const item = (await db.send(new GetCommand({ TableName: TABLES.blocks.tableName, Key: { subject: `writer#${rapide}` } }))).Item!;
    expect(item.expireLe).toBe(clock + WRITER_BLOCK_MS);
    // Un serveur redémarré relit le blocage.
    const restarted = new WriterGuard(db, () => clock);
    await restarted.load(rapide);
    expect(restarted.blocked(rapide)).toBe(clock + WRITER_BLOCK_MS);
  });

  it("un client qui s'acharne après l'épuisement du crédit est bloqué (4003 avec heure de fin)", async () => {
    const email = `acharne-${Date.now()}@abus.local`;
    const docId = await createDocument(db, [email]);
    let refusal: { code: number; finLe?: number } | undefined;
    // Client malveillant : ignore le refus, recrée une connexion et réessaie aussitôt.
    for (let attempt = 0; attempt < 8 && refusal?.code !== REFUSAL.bloque.code; attempt++) {
      const w = new TestWriter(rt.url, docId, testToken(email));
      writers.push(w);
      await w.synced();
      w.insert(0, "x".repeat(attempt === 0 ? 10_000 : 600));
      await waitFor(() => w.refusal !== undefined || w.acks.length > 0, 30_000, "réponse");
      refusal = w.refusal;
      w.destroy();
    }
    expect(refusal?.code).toBe(REFUSAL.bloque.code);
    // Bloqué, il lit toujours le document (synchronisation acceptée).
    const reader = new TestWriter(rt.url, docId, testToken(email));
    writers.push(reader);
    await reader.synced();
    expect(reader.text.length).toBe(10_000);
    expect(refusal?.finLe).toBeGreaterThan(Date.now() + WRITER_BLOCK_MS - 60_000);
    expect(rt.refusals.filter((r) => r.writer === email).length).toBeGreaterThanOrEqual(5);
  });

  it("présence : un battement par document ouvert", async () => {
    const docId = await createDocument(db, ["presence@abus.local"]);
    const w = new TestWriter(rt.url, docId, testToken("presence@abus.local"));
    writers.push(w);
    await w.synced();
    await rt.beat();
    const item = (await db.send(new GetCommand({ TableName: TABLES.presence.tableName, Key: { docId } }))).Item!;
    expect(item).toMatchObject({ title: "Test temps réel", connected: 1 });
    expect(item.lastBeat).toBeGreaterThan(Date.now() - 10_000);
  });
});
