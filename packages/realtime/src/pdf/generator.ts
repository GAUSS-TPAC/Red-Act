/**
 * Génération des PDF (CLAUDE.md §6, C3) : une seule à la fois par document.
 *
 * 1. Copie SYNCHRONE du texte à la séquence S (document ouvert : la copie de
 *    référence vaut exactement `committer.seq` ; sinon chargement instantané + journal).
 * 2. Rendu sur cette copie (worker thread), écriture S3 `pdf/{doc}/{S}.pdf`.
 * 3. PUIS bascule `pdfSeq = S`, à condition que `pdfSeq < S`.
 * L'API ne délivre une URL que si `pdfSeq ≥ seqRequis` : le PDF servi est donc
 * toujours complet (déjà écrit) et contient au moins tout ce qui était accepté au clic.
 * Une génération sert toutes les demandes dont `seqRequis ≤ S`.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { pdfKey, TABLES, TEXT_NAME, type DocumentItem } from "@editeur/shared";
import { loadDocument, type BlobStore } from "../store.ts";
import type { RenderInput } from "./render.ts";

export interface PdfGeneratorDeps {
  db: DynamoDBDocumentClient;
  blobs: BlobStore;
  render: (input: RenderInput) => Promise<Uint8Array>;
  /** Texte et séquence d'un document ouvert, lus de façon synchrone (undefined sinon). */
  openState: (docId: string) => { text: string; seq: number } | undefined;
  now?: () => number;
  log?: { info: (obj: unknown, msg: string) => void };
}

export class PdfGenerator {
  private readonly inflight = new Map<string, Promise<number>>();
  private readonly now: () => number;
  /** Nombre de rendus effectués (mesure, tests). */
  renders = 0;

  constructor(private readonly deps: PdfGeneratorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Résout quand `pdfSeq ≥ seqRequis` (ou au mieux la séquence actuelle du document). */
  async request(docId: string, seqRequis: number): Promise<void> {
    for (;;) {
      const current = this.inflight.get(docId);
      if (current) {
        // Une génération est en cours : si elle couvre la demande, on l'attend ;
        // sinon on l'attend puis on en relance une (une seule à la fois).
        if ((await current) >= seqRequis) return;
        continue;
      }
      const generation = this.generate(docId).finally(() => {
        if (this.inflight.get(docId) === generation) this.inflight.delete(docId);
      });
      this.inflight.set(docId, generation);
      await generation;
      return;
    }
  }

  /** Renvoie la séquence du PDF disponible après la génération. */
  private async generate(docId: string): Promise<number> {
    // Étape 1, avant tout `await` : l'état ne peut plus bouger sous nos pieds.
    let state = this.deps.openState(docId);

    const item = (
      await this.deps.db.send(
        new GetCommand({
          TableName: TABLES.documents.tableName,
          Key: { docId },
          ConsistentRead: true,
          ProjectionExpression: "title, pdfSeq",
        }),
      )
    ).Item as Pick<DocumentItem, "title" | "pdfSeq"> | undefined;
    if (!item) throw new Error(`document inconnu : ${docId}`);

    if (!state) {
      const loaded = await loadDocument(this.deps.db, this.deps.blobs, docId);
      if (!loaded) throw new Error(`document inconnu : ${docId}`);
      state = { text: loaded.doc.getText(TEXT_NAME).toString(), seq: loaded.seq };
    }
    if (item.pdfSeq >= state.seq) return item.pdfSeq;

    const generatedAt = this.now();
    const pdf = await this.deps.render({ title: item.title, text: state.text, seq: state.seq, generatedAt });
    this.renders++;
    await this.deps.blobs.put(pdfKey(docId, state.seq), pdf, "application/pdf");
    try {
      await this.deps.db.send(
        new UpdateCommand({
          TableName: TABLES.documents.tableName,
          Key: { docId },
          UpdateExpression: "SET pdfSeq = :s",
          ConditionExpression: "pdfSeq < :s",
          ExpressionAttributeValues: { ":s": state.seq },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
    this.deps.log?.info({ docId, seq: state.seq, ms: this.now() - generatedAt }, "PDF généré");
    return state.seq;
  }
}
