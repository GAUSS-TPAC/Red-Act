/**
 * Serveur temps réel : Hocuspocus 4.7.1 + journal DynamoDB (CLAUDE.md §5).
 *
 * Vérifié dans le code de Hocuspocus 4.7.1 : `MessageReceiver.readSyncMessage`
 * attend le hook `beforeSync` AVANT d'appliquer un update (`readUpdate`). On y
 * retient donc chaque update jusqu'à son écriture dans DynamoDB ; le committer
 * l'applique lui-même à la copie de référence après succès (diffusion), puis
 * Hocuspocus le réapplique sans effet (Yjs est idempotent) et confirme au client
 * (SyncStatus). Lever une erreur dans `beforeSync` ferme la connexion au document.
 */
import { Server, type Connection } from "@hocuspocus/server";
import { ScanCommand, GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  REFUSAL,
  TABLES,
  nextUtcMidnight,
  verifySessionToken,
  type DocumentItem,
  type RefusalCode,
  type ServerMessage,
} from "@editeur/shared";
import * as Y from "yjs";
import { analyzeUpdate } from "./content.ts";
import { DocumentCommitter, Refusal } from "./committer.ts";
import { loadDocument, saveSnapshot, type BlobStore } from "./store.ts";

/** Compaction toutes les ~5 min d'activité ou tous les 500 éléments de journal. */
export const COMPACTION = { maxEntries: 500, maxAgeMs: 5 * 60 * 1000 };

export interface Writer {
  email: string;
  name: string;
}

export interface RealtimeDeps {
  db: DynamoDBDocumentClient;
  blobs: BlobStore;
  hmacSecret: string;
  /** Port d'écoute (0 : port libre, pour les tests). */
  port?: number;
  now?: () => number;
  compaction?: { maxEntries: number; maxAgeMs: number };
  /** Chaque refus 4001/4003 compte pour l'anti-abus (étape 6). */
  onRefusal?: (writer: string, code: RefusalCode) => void;
  log?: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void };
}

interface OpenDocument {
  committer: DocumentCommitter;
  snapshotSeq: number;
  lastSnapshotAt: number;
  compacting?: Promise<void>;
}

export function createRealtimeServer(deps: RealtimeDeps) {
  const now = deps.now ?? Date.now;
  const compaction = deps.compaction ?? COMPACTION;
  const open = new Map<string, OpenDocument>();

  const compact = (docId: string, entry: OpenDocument, doc: Y.Doc) => {
    if (entry.compacting || entry.committer.seq <= entry.snapshotSeq) return entry.compacting;
    // État capturé de façon synchrone : il correspond exactement à `seq`.
    const seq = entry.committer.seq;
    const state = Y.encodeStateAsUpdate(doc);
    entry.compacting = saveSnapshot(deps.db, deps.blobs, docId, seq, state, now())
      .then(() => {
        entry.snapshotSeq = Math.max(entry.snapshotSeq, seq);
        entry.lastSnapshotAt = now();
      })
      .catch((error: unknown) => deps.log?.error({ error, docId }, "compaction impossible (le journal reste la référence)"))
      .finally(() => (entry.compacting = undefined));
    return entry.compacting;
  };

  const refuse = (connection: Connection<Writer>, writer: string, refusal: Refusal): never => {
    const message: ServerMessage = {
      type: "refus",
      code: refusal.code as RefusalCode,
      raison: refusal.reason,
      ...(refusal.code === REFUSAL.creditEpuise.code ? { finLe: nextUtcMidnight(now()) } : {}),
    };
    connection.sendStateless(JSON.stringify(message));
    if (refusal.code === REFUSAL.creditEpuise.code || refusal.code === REFUSAL.bloque.code) {
      deps.onRefusal?.(writer, refusal.code as RefusalCode);
    }
    // Hocuspocus ferme la connexion au document avec ce code et cette raison.
    throw Object.assign(new Error(refusal.message), { code: refusal.code, reason: refusal.message });
  };

  const server = new Server<Writer>({
    port: deps.port ?? 1234,
    quiet: true,
    stopOnSignals: false,

    // Contrôle de santé de l'ALB : ne dépend d'aucun service AWS.
    async onRequest({ request, response }) {
      if (request.url?.startsWith("/sante")) {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ statut: "ok" }));
        // Rejet sans erreur : Hocuspocus n'écrit pas sa propre réponse.
        return Promise.reject();
      }
    },

    async onAuthenticate({ token, documentName }) {
      const session = verifySessionToken(token, deps.hmacSecret, Math.floor(now() / 1000));
      if (!session.ok) throw new Error("session-invalide");
      const doc = (
        await deps.db.send(
          new GetCommand({
            TableName: TABLES.documents.tableName,
            Key: { docId: documentName },
            ConsistentRead: true,
            ProjectionExpression: "editors",
          }),
        )
      ).Item as Pick<DocumentItem, "editors"> | undefined;
      if (!doc?.editors.has(session.claims.email)) throw new Error("acces-refuse");
      return { email: session.claims.email, name: session.claims.name } satisfies Writer;
    },

    async onLoadDocument({ documentName, document }) {
      const loaded = await loadDocument(deps.db, deps.blobs, documentName);
      if (!loaded) throw new Error(`document inconnu : ${documentName}`);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(loaded.doc));
      const entry: OpenDocument = {
        snapshotSeq: loaded.snapshotSeq,
        lastSnapshotAt: now(),
        committer: new DocumentCommitter({
          db: deps.db,
          docId: documentName,
          doc: document,
          seq: loaded.seq,
          now,
          log: deps.log,
          onCommitted: (seq) => {
            if (seq - entry.snapshotSeq >= compaction.maxEntries || now() - entry.lastSnapshotAt >= compaction.maxAgeMs) {
              void compact(documentName, entry, document);
            }
          },
        }),
      };
      open.set(documentName, entry);
      deps.log?.info({ docId: documentName, seq: loaded.seq, snapshotSeq: loaded.snapshotSeq }, "document chargé");
    },

    async beforeSync({ type, payload, document, documentName, connection, context }) {
      if (type === 0) return; // SyncStep1 : simple demande d'état
      const entry = open.get(documentName);
      if (!entry) throw new Error(`document non chargé : ${documentName}`);

      const analysis = analyzeUpdate(payload, Y.encodeStateVector(document));
      if (!analysis.valid) {
        refuse(connection, context.email, new Refusal(REFUSAL.contenuInvalide.code, REFUSAL.contenuInvalide.raison));
        return;
      }
      if (analysis.empty) return;

      try {
        const seq = await entry.committer.submit(payload, context.email, analysis.chars);
        connection.sendStateless(JSON.stringify({ type: "ack", seq } satisfies ServerMessage));
      } catch (error) {
        if (error instanceof Refusal) refuse(connection, context.email, error);
        throw error;
      }
    },

    // Dernier client parti : on attend les écritures en cours, puis instantané.
    async beforeUnloadDocument({ documentName, document }) {
      const entry = open.get(documentName);
      if (!entry) return;
      await entry.committer.drain();
      await entry.compacting;
      await compact(documentName, entry, document);
      open.delete(documentName);
    },
  });

  return { server, open };
}

/**
 * Au démarrage : documents dont le journal n'a pas été compacté (arrêt brutal du
 * serveur précédent). On les compacte avant que le TTL du journal n'approche.
 */
export async function compactPending(deps: Pick<RealtimeDeps, "db" | "blobs" | "log" | "now">) {
  const now = deps.now ?? Date.now;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let count = 0;
  do {
    const page = await deps.db.send(
      new ScanCommand({
        TableName: TABLES.documents.tableName,
        FilterExpression: "seq > snapshotSeq",
        ProjectionExpression: "docId",
        ExclusiveStartKey,
      }),
    );
    for (const { docId } of page.Items ?? []) {
      const loaded = await loadDocument(deps.db, deps.blobs, docId as string);
      if (!loaded) continue;
      await saveSnapshot(deps.db, deps.blobs, docId as string, loaded.seq, Y.encodeStateAsUpdate(loaded.doc), now());
      count++;
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  deps.log?.info({ count }, "compaction des documents en attente");
}
