// Vérifications C2 communes au test Vitest et au script de mesure.
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLES, TEXT_NAME } from "@editeur/shared";
import * as Y from "yjs";
import { loadDocument, type BlobStore } from "../../packages/realtime/src/store.ts";
import { stateVector, type TestWriter } from "../helpers/realtime.ts";

export interface ConvergenceReport {
  clients: number;
  length: number;
  /** Tous les clients ont le même texte… */
  identicalTexts: boolean;
  /** … et le même vecteur d'état (ils ont intégré exactement les mêmes modifications). */
  identicalStateVectors: boolean;
  /** L'état relu depuis DynamoDB (+ instantané) est celui des clients. */
  persistedMatches: boolean;
  ackedSeqs: number;
  /** Séquences confirmées à un client mais absentes du journal ou du document final. */
  missingAckedSeqs: number[];
  journalSeq: number;
}

export async function checkConvergence(
  db: DynamoDBDocumentClient,
  blobs: BlobStore,
  docId: string,
  clients: TestWriter[],
): Promise<ConvergenceReport> {
  const texts = clients.map((c) => c.text.toString());
  const vectors = clients.map((c) => JSON.stringify(stateVector(c.doc)));
  const persisted = (await loadDocument(db, blobs, docId))!;

  // Chaque seq confirmé : présent dans le journal, et son contenu inclus dans l'état final.
  const journal = new Map<number, Uint8Array>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: TABLES.journal.tableName,
        KeyConditionExpression: "docId = :d",
        ExpressionAttributeValues: { ":d": docId },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) journal.set(item.seq as number, item.update as Uint8Array);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const finalSnapshot = Y.snapshot(clients[0]!.doc);
  const acked = [...new Set(clients.flatMap((c) => c.acks))].sort((a, b) => a - b);
  const missingAckedSeqs = acked.filter((seq) => {
    const update = journal.get(seq);
    return !update || !Y.snapshotContainsUpdate(finalSnapshot, update);
  });

  return {
    clients: clients.length,
    length: texts[0]!.length,
    identicalTexts: texts.every((t) => t === texts[0]),
    identicalStateVectors: vectors.every((v) => v === vectors[0]),
    persistedMatches:
      persisted.doc.getText(TEXT_NAME).toString() === texts[0] &&
      JSON.stringify(stateVector(persisted.doc)) === vectors[0],
    ackedSeqs: acked.length,
    missingAckedSeqs,
    journalSeq: persisted.seq,
  };
}
