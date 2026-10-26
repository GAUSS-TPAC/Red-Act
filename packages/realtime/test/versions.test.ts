// Versions (§5) : enregistrer une version nommée, restaurer sans débit de crédit.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditKey, TABLES, TEXT_NAME } from "@editeur/shared";
import { createDocumentClient } from "../src/aws.ts";
import { loadDocument } from "../src/store.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../../scripts/local-tables.ts";
import { createDocument, startRealtime, TestWriter, testToken, waitFor } from "../../../tests/helpers/realtime.ts";

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

describe.skipIf(!dbUp)("versions (DynamoDB Local)", () => {
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

  it("enregistre une version nommée puis la restaure comme une nouvelle modification, sans crédit", async () => {
    const email = `v-${Date.now()}@versions.local`;
    const docId = await createDocument(db, [email, "autre@versions.local"]);
    const w = new TestWriter(rt.url, docId, testToken(email));
    const other = new TestWriter(rt.url, docId, testToken("autre@versions.local"));
    writers.push(w, other);
    await Promise.all([w.synced(), other.synced()]);

    w.insert(0, "Version un");
    await w.idle();
    w.provider.sendStateless(JSON.stringify({ type: "enregistrer", label: "  Bouclage  " }));
    await waitFor(() => w.messages.some((m) => m.type === "version-enregistree"), 5_000, "version enregistrée");

    const versions = await db.send(
      new QueryCommand({
        TableName: TABLES.versions.tableName,
        KeyConditionExpression: "docId = :d",
        ExpressionAttributeValues: { ":d": docId },
      }),
    );
    const named = versions.Items!.find((v) => v.label === "Bouclage")!;
    expect(named).toMatchObject({ author: email, seq: w.acks.at(-1) });

    w.insert(w.text.length, " puis beaucoup de changements");
    await w.idle();
    const credit = async () =>
      (await db.send(new GetCommand({ TableName: TABLES.credits.tableName, Key: { pk: creditKey(email) }, ConsistentRead: true })))
        .Item!.used as number;
    const usedBefore = await credit();

    w.provider.sendStateless(JSON.stringify({ type: "restaurer", snapshotKey: named.snapshotKey }));
    await waitFor(() => w.messages.some((m) => m.type === "restauree"), 5_000, "restauration");
    // Diffusée à tous, écrite dans le journal, crédit inchangé.
    await waitFor(() => other.text.toString() === "Version un", 5_000, "diffusion");
    expect(w.text.toString()).toBe("Version un");
    expect((await loadDocument(db, rt.blobs, docId))!.doc.getText(TEXT_NAME).toString()).toBe("Version un");
    expect(await credit()).toBe(usedBefore);
  });

  it("aperçu puis restauration d'une version mise en forme : formats conservés", async () => {
    const email = `f-${Date.now()}@versions.local`;
    const docId = await createDocument(db, [email]);
    const w = new TestWriter(rt.url, docId, testToken(email));
    writers.push(w);
    await w.synced();

    w.text.insert(0, "Titre", { bold: true, size: "large" });
    w.text.insert(5, " corps", { font: "serif" });
    await w.idle();
    w.provider.sendStateless(JSON.stringify({ type: "enregistrer", label: "Mise en forme" }));
    await waitFor(() => w.messages.some((m) => m.type === "version-enregistree"), 5_000, "version enregistrée");
    const named = (
      await db.send(new QueryCommand({ TableName: TABLES.versions.tableName, KeyConditionExpression: "docId = :d", ExpressionAttributeValues: { ":d": docId } }))
    ).Items!.find((v) => v.label === "Mise en forme")!;
    const expected = [
      { insert: "Titre", attributes: { bold: true, size: "large" } },
      { insert: " corps", attributes: { font: "serif" } },
    ];

    w.provider.sendStateless(JSON.stringify({ type: "apercu", snapshotKey: named.snapshotKey }));
    await waitFor(() => w.messages.some((m) => m.type === "apercu"), 5_000, "aperçu");
    expect(w.messages.find((m) => m.type === "apercu")).toEqual({ type: "apercu", snapshotKey: named.snapshotKey, delta: expected });

    w.text.delete(0, w.text.length);
    w.text.insert(0, "autre chose");
    await w.idle();
    w.provider.sendStateless(JSON.stringify({ type: "restaurer", snapshotKey: named.snapshotKey }));
    await waitFor(() => w.messages.some((m) => m.type === "restauree"), 5_000, "restauration");
    await waitFor(() => w.text.toString() === "Titre corps", 5_000, "diffusion");
    expect(w.text.toDelta()).toEqual(expected);
    expect((await loadDocument(db, rt.blobs, docId))!.doc.getText(TEXT_NAME).toDelta()).toEqual(expected);
  });

  it("refuse de restaurer l'instantané d'un autre document", async () => {
    const docId = await createDocument(db, ["x@versions.local"]);
    const w = new TestWriter(rt.url, docId, testToken("x@versions.local"));
    writers.push(w);
    await w.synced();
    w.provider.sendStateless(JSON.stringify({ type: "restaurer", snapshotKey: "snapshots/autre-doc/1.bin" }));
    await waitFor(() => w.messages.some((m) => m.type === "erreur"), 5_000, "erreur");
  });
});
