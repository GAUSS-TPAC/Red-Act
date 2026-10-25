/**
 * Chargement et compaction d'un document (CLAUDE.md §5).
 *
 * Chargement : dernier instantané S3 + éléments du journal de `seq` > `snapshotSeq`.
 * Compaction : état complet à la séquence S → S3 `snapshots/{doc}/{S}.bin` → pointeur
 * dans le document (seulement s'il avance). Une panne au milieu ne perd rien : le
 * journal reste la référence tant que le pointeur n'a pas bougé, et Yjs est idempotent.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { snapshotKey, TABLES, type DocumentItem } from "@editeur/shared";
import * as Y from "yjs";

/** Stockage des instantanés : S3 sur AWS, mémoire dans les tests. */
export interface BlobStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export function memoryBlobStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(key, body) {
      blobs.set(key, body);
    },
    async get(key) {
      const body = blobs.get(key);
      if (!body) throw new Error(`instantané absent : ${key}`);
      return body;
    },
  };
}

export interface LoadedDocument {
  doc: Y.Doc;
  seq: number;
  snapshotSeq: number;
}

export async function loadDocument(
  db: DynamoDBDocumentClient,
  blobs: BlobStore,
  docId: string,
): Promise<LoadedDocument | undefined> {
  const item = (
    await db.send(new GetCommand({ TableName: TABLES.documents.tableName, Key: { docId }, ConsistentRead: true }))
  ).Item as DocumentItem | undefined;
  if (!item) return undefined;

  const doc = new Y.Doc();
  if (item.snapshotKey) Y.applyUpdate(doc, await blobs.get(item.snapshotKey));

  let expected = item.snapshotSeq + 1;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: TABLES.journal.tableName,
        KeyConditionExpression: "docId = :d AND seq > :s",
        ExpressionAttributeValues: { ":d": docId, ":s": item.snapshotSeq },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const entry of page.Items ?? []) {
      // Un trou dans le journal serait une perte : on refuse de servir un état incomplet.
      if (entry.seq !== expected) throw new Error(`journal de ${docId} incomplet : seq ${expected} absent`);
      Y.applyUpdate(doc, entry.update as Uint8Array);
      expected++;
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  if (expected !== item.seq + 1) throw new Error(`journal de ${docId} incomplet : ${expected - 1} < ${item.seq}`);

  return { doc, seq: item.seq, snapshotSeq: item.snapshotSeq };
}

/**
 * `state` doit être l'état complet du document à la séquence `seq` exactement
 * (capturé de façon synchrone juste après un commit).
 * Renvoie false si un instantané plus récent existait déjà.
 */
export async function saveSnapshot(
  db: DynamoDBDocumentClient,
  blobs: BlobStore,
  docId: string,
  seq: number,
  state: Uint8Array,
  now: number,
): Promise<boolean> {
  const key = snapshotKey(docId, seq);
  await blobs.put(key, state);
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLES.documents.tableName,
        Key: { docId },
        UpdateExpression: "SET snapshotSeq = :s, snapshotKey = :k",
        ConditionExpression: "snapshotSeq < :s",
        ExpressionAttributeValues: { ":s": seq, ":k": key },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
  // Chaque instantané de compaction est aussi une version restaurable (§5).
  await db.send(
    new PutCommand({
      TableName: TABLES.versions.tableName,
      Item: { docId, createdAt: now, snapshotKey: key, seq, label: "automatique" },
    }),
  );
  return true;
}
