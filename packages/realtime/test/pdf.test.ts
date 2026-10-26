import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fontFor, renderPdf } from "../src/pdf/render.ts";
import { pdfText } from "../../../tests/helpers/pdf.ts";
import { PdfGenerator } from "../src/pdf/generator.ts";
import { memoryBlobStore } from "../src/store.ts";
import { createDocumentClient } from "../src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../../scripts/local-tables.ts";
import { createDocument, startRealtime, TestWriter, testToken } from "../../../tests/helpers/realtime.ts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { TABLES } from "@editeur/shared";

describe("renderPdf", () => {
  it("produit un PDF qui contient le titre, la version et le texte (accents compris)", async () => {
    const pdf = await renderPdf(
      { title: "Journal", text: "Éditorial : ça va", seq: 7, generatedAt: Date.UTC(2026, 9, 25) },
      { compress: false },
    );
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain("Journal");
    expect(text).toContain("Version 7");
    expect(text).toContain("Éditorial : ça va");
  });
});

describe("renderPdf — mise en forme", () => {
  it("polices standard selon le format (gras, italique, police, taille) et soulignement", async () => {
    expect(fontFor({})).toEqual({ font: "Helvetica", size: 11, underline: false });
    expect(fontFor({ bold: true, italic: true, font: "serif", size: "huge", underline: true })).toEqual({
      font: "Times-BoldItalic",
      size: 27.5,
      underline: true,
    });
    expect(fontFor({ italic: true, font: "monospace", size: "small" })).toEqual({ font: "Courier-Oblique", size: 8.25, underline: false });
    const pdf = await renderPdf(
      {
        title: "Journal",
        text: "Gros titre et corps",
        delta: [
          { insert: "Gros titre", attributes: { bold: true, size: "huge" } },
          { insert: " et corps", attributes: { font: "serif", underline: true } },
        ],
        seq: 3,
        generatedAt: Date.UTC(2026, 9, 26),
      },
      { compress: false },
    );
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw).toContain("/BaseFont /Helvetica-Bold");
    expect(raw).toContain("/BaseFont /Times-Roman");
    expect(pdfText(pdf)).toContain("Gros titre");
  });
});

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

describe.skipIf(!dbUp)("PdfGenerator (DynamoDB Local)", () => {
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

  const generatorFor = (openState: (id: string) => { text: string; seq: number } | undefined) => {
    const rendered: { text: string; seq: number }[] = [];
    const generator = new PdfGenerator({
      db,
      blobs: rt.blobs,
      openState,
      render: async (input) => {
        rendered.push({ text: input.text, seq: input.seq });
        await new Promise((resolve) => setTimeout(resolve, 50)); // rendu « lent »
        return renderPdf(input, { compress: false });
      },
    });
    return { generator, rendered };
  };

  const pdfSeq = async (docId: string) =>
    (await db.send(new GetCommand({ TableName: TABLES.documents.tableName, Key: { docId }, ConsistentRead: true })))
      .Item!.pdfSeq as number;

  it("document ouvert : rendu de l'état exact à seq, un seul rendu pour des demandes simultanées", async () => {
    const docId = await createDocument(db, ["p@pdf.local"]);
    const w = new TestWriter(rt.url, docId, testToken("p@pdf.local"));
    writers.push(w);
    await w.synced();
    w.insert(0, "Bonjour");
    await w.idle();
    const seq = w.acks.at(-1)!;

    const { generator, rendered } = generatorFor(rt.openState);
    await Promise.all(Array.from({ length: 5 }, () => generator.request(docId, seq)));
    expect(rendered).toEqual([{ text: "Bonjour", seq }]);
    expect(await pdfSeq(docId)).toBe(seq);
    expect(pdfText(rt.blobs.blobs.get(`pdf/${docId}/${seq}.pdf`)!)).toContain("Bonjour");

    // Déjà couvert : aucun nouveau rendu.
    await generator.request(docId, seq);
    expect(rendered).toHaveLength(1);

    // Une demande plus récente pendant un rendu en cours : un second rendu, après le premier.
    w.insert(7, " tout le monde");
    await w.idle();
    const seq2 = w.acks.at(-1)!;
    await Promise.all([generator.request(docId, seq2), generator.request(docId, seq2)]);
    expect(rendered.at(-1)).toEqual({ text: "Bonjour tout le monde", seq: seq2 });
    expect(rendered).toHaveLength(2);
    expect(await pdfSeq(docId)).toBe(seq2);
  });

  it("document fermé : chargé depuis l'instantané et le journal", async () => {
    const docId = await createDocument(db, ["f@pdf.local"]);
    const w = new TestWriter(rt.url, docId, testToken("f@pdf.local"));
    await w.synced();
    w.insert(0, "Texte fermé");
    await w.idle();
    const seq = w.acks.at(-1)!;
    w.destroy();

    const { generator, rendered } = generatorFor(() => undefined);
    await generator.request(docId, seq);
    expect(rendered).toEqual([{ text: "Texte fermé", seq }]);
  });

  it("ne fait jamais reculer pdfSeq", async () => {
    const docId = await createDocument(db, ["r@pdf.local"]);
    const { generator } = generatorFor(() => ({ text: "x", seq: 0 }));
    await generator.request(docId, 0);
    expect(await pdfSeq(docId)).toBe(0);
    const { generator: stale, rendered } = generatorFor(() => ({ text: "ancien", seq: 0 }));
    await stale.request(docId, 0);
    expect(rendered).toEqual([]); // pdfSeq (0) couvre déjà seq 0
  });
});
