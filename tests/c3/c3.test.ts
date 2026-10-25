/**
 * C3 en local, de bout en bout : un lien utilisé à T1 donne un PDF complet et
 * cohérent qui contient tout ce qui était accepté à T1.
 *   - « contient tout » : chaque modification confirmée avant le clic est dans le PDF ;
 *   - « cohérent » : le texte rendu est exactement celui du journal rejoué jusqu'à S ;
 *   - « complet » : l'URL n'est donnée qu'une fois le fichier entièrement écrit.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TABLES, TEXT_NAME } from "@editeur/shared";
import { createDocumentClient } from "../../packages/api/src/aws.ts";
import { readCookie } from "../../packages/api/src/routes.ts";
import { consumePdfRequests, type PdfQueue } from "../../packages/realtime/src/pdf/consumer.ts";
import { PdfGenerator } from "../../packages/realtime/src/pdf/generator.ts";
import { renderPdf } from "../../packages/realtime/src/pdf/render.ts";
import { pdfText } from "../helpers/pdf.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";
import { createLocalApi } from "../helpers/local-api.ts";
import { startRealtime, TestWriter, testToken, waitFor } from "../helpers/realtime.ts";

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

/**
 * File en mémoire, à la place de SQS (même interface) : comme SQS, un message lu
 * devient invisible pendant 2 s (délai de visibilité), puis réapparaît s'il n'a pas
 * été supprimé.
 */
function memoryQueue(): PdfQueue & { send: (docId: string, seqRequis: number) => Promise<void>; size: () => number } {
  let messages: { handle: string; request: { docId: string; seqRequis: number }; visibleAt: number }[] = [];
  let next = 0;
  return {
    async send(docId, seqRequis) {
      messages.push({ handle: String(next++), request: { docId, seqRequis }, visibleAt: 0 });
    },
    async receive() {
      for (let waited = 0; waited < 1_000; waited += 20) {
        const visible = messages.filter((m) => m.visibleAt <= Date.now()).slice(0, 10);
        if (visible.length > 0) {
          for (const m of visible) m.visibleAt = Date.now() + 2_000;
          return visible.map(({ handle, request }) => ({ handle, request }));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return [];
    },
    async remove(handles) {
      messages = messages.filter((m) => !handles.includes(m.handle));
    },
    size: () => messages.length,
  };
}

async function textAt(docId: string, seq: number): Promise<string> {
  const doc = new Y.Doc();
  const page = await db.send(
    new QueryCommand({
      TableName: TABLES.journal.tableName,
      KeyConditionExpression: "docId = :d AND seq <= :s",
      ExpressionAttributeValues: { ":d": docId, ":s": seq },
      ConsistentRead: true,
    }),
  );
  for (const item of page.Items ?? []) Y.applyUpdate(doc, item.update as Uint8Array);
  return doc.getText(TEXT_NAME).toString();
}

describe.skipIf(!dbUp)("C3 — le document tel qu'au clic, complet et cohérent (DynamoDB Local)", () => {
  let rt: Awaited<ReturnType<typeof startRealtime>>;
  const stop = new AbortController();
  const queue = memoryQueue();
  const rendered: { seq: number; text: string }[] = [];
  let api: ReturnType<typeof createLocalApi>;
  const writers: TestWriter[] = [];

  beforeAll(async () => {
    await ensureLocalTables();
    rt = await startRealtime(db);
    const generator = new PdfGenerator({
      db,
      blobs: rt.blobs,
      openState: rt.openState,
      render: async (input) => {
        rendered.push({ seq: input.seq, text: input.text });
        return renderPdf(input, { compress: false });
      },
    });
    void consumePdfRequests(queue, generator, { signal: stop.signal });
    api = createLocalApi(undefined, { requestPdf: queue.send });
  });
  afterAll(async () => {
    stop.abort();
    for (const w of writers) w.destroy();
    await api.app.close();
    await rt.server.destroy();
  });

  it("le PDF reçu après le clic contient tout ce qui était accepté au clic", async () => {
    const email = `c3-${Date.now()}@c3.local`;
    const auth = { authorization: `Bearer ${testToken(email)}` };
    const docId = (await api.app.inject({ method: "POST", url: "/api/documents", headers: auth, payload: { title: "Gazette" } })).json()
      .docId as string;

    const w = new TestWriter(rt.url, docId, testToken(email));
    writers.push(w);
    await w.synced();
    w.insert(0, "AVANT-LE-LIEN ");
    await w.idle();

    // Création du lien : le PDF de l'état actuel est préparé tout de suite.
    const link = (
      await api.app.inject({ method: "POST", url: `/api/documents/${docId}/links`, headers: auth, payload: { max: 3 } })
    ).json();
    await waitFor(() => rendered.some((r) => r.text === "AVANT-LE-LIEN "), 10_000, "PDF préparé");

    // Modification acceptée après la préparation, avant le clic (T1).
    w.insert(w.text.length, "AVANT-LE-CLIC ");
    await w.idle();
    const acceptedAtClick = w.text.toString();

    const first = await api.app.inject({ method: "POST", url: `/api/links/${link.linkId}/claim` });
    expect(first.statusCode).toBe(202); // le PDF préparé est périmé : on patiente
    const ticket = readCookie(String(first.headers["set-cookie"]).split(";")[0], "ticket")!;

    // Écrit APRÈS le clic : peut figurer dans le PDF (au moins T1), jamais à moitié.
    w.insert(w.text.length, "APRES-LE-CLIC");

    let response = first;
    const deadline = Date.now() + 15_000;
    while (response.statusCode !== 200) {
      if (Date.now() > deadline) throw new Error(`PDF jamais prêt : ${response.statusCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await api.app.inject({
        method: "POST",
        url: `/api/links/${link.linkId}/claim`,
        headers: { cookie: `ticket=${ticket}` },
      });
    }

    const key = new URL(response.json().url).pathname.slice(1);
    const seq = Number(key.match(/^pdf\/[^/]+\/(\d+)\.pdf$/)![1]);
    const pdf = rt.blobs.blobs.get(key)!;
    const inPdf = pdfText(pdf);

    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(inPdf).toContain(acceptedAtClick); // tout ce qui était accepté au clic
    const coherent = await textAt(docId, seq);
    expect(rendered.find((r) => r.seq === seq)?.text).toBe(coherent); // état exact du journal à S
    expect(inPdf).toContain(coherent);
    expect(queue.size()).toBe(0); // demandes traitées puis supprimées
  });
});
