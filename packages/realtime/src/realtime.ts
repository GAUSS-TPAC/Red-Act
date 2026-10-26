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
import { performance } from "node:perf_hooks";
import { Server, type Connection, type Document } from "@hocuspocus/server";
import { ScanCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  REFUSAL,
  TABLES,
  TEXT_NAME,
  nextUtcMidnight,
  verifySessionToken,
  type ClientMessage,
  type DocumentItem,
  type RefusalCode,
  type Segment,
  type ServerMessage,
} from "@editeur/shared";
import * as Y from "yjs";
import { WriterGuard } from "./abuse.ts";
import { analyzeUpdate } from "./content.ts";
import { DocumentCommitter, Refusal } from "./committer.ts";
import { loadDocument, saveSnapshot, type BlobStore } from "./store.ts";

/** Compaction toutes les ~5 min d'activité ou tous les 500 éléments de journal. */
export const COMPACTION = { maxEntries: 500, maxAgeMs: 5 * 60 * 1000 };
/** Battement de présence des documents ouverts, pour le tableau de bord (§5). */
export const PRESENCE_INTERVAL_MS = 30_000;
/**
 * Mesure côté serveur, écrite dans les journaux (CloudWatch) toutes les 30 s :
 * retard réception → confirmation des modifications et charge de la boucle
 * d'événements. Elle ne dépend pas du générateur de charge (rapport de test).
 */
export const MEASURE_INTERVAL_MS = 30_000;

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
  /** Copie de référence (document Hocuspocus). */
  doc: Document;
  title: string;
  committer: DocumentCommitter;
  snapshotSeq: number;
  lastSnapshotAt: number;
  compacting?: Promise<void>;
}

export function createRealtimeServer(deps: RealtimeDeps) {
  const now = deps.now ?? Date.now;
  const compaction = deps.compaction ?? COMPACTION;
  const open = new Map<string, OpenDocument>();
  const writers = new WriterGuard(deps.db, now);
  let latencies: number[] = [];

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
    const finLe = refusal.finLe ?? (refusal.code === REFUSAL.creditEpuise.code ? nextUtcMidnight(now()) : undefined);
    const message: ServerMessage = {
      type: "refus",
      code: refusal.code as RefusalCode,
      raison: refusal.reason,
      ...(finLe !== undefined ? { finLe } : {}),
    };
    connection.sendStateless(JSON.stringify(message));
    if (refusal.code === REFUSAL.creditEpuise.code || refusal.code === REFUSAL.bloque.code) {
      // Chaque fermeture 4001/4003 compte pour l'anti-abus (5 en 1 min → 5 h de blocage).
      deps.onRefusal?.(writer, refusal.code as RefusalCode);
      void writers
        .record(writer)
        .then((until) => until && deps.log?.info({ writer, until: new Date(until).toISOString() }, "rédacteur bloqué"))
        .catch((error: unknown) => deps.log?.error({ error, writer }, "écriture du blocage impossible"));
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
      // Blocage éventuel (5 h) : la connexion est acceptée, ses modifications seront refusées (4003).
      await writers.load(session.claims.email);
      return { email: session.claims.email, name: session.claims.name } satisfies Writer;
    },

    async onLoadDocument({ documentName, document }) {
      const loaded = await loadDocument(deps.db, deps.blobs, documentName);
      if (!loaded) throw new Error(`document inconnu : ${documentName}`);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(loaded.doc));
      const entry: OpenDocument = {
        doc: document,
        title: loaded.title,
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

      // Un rédacteur bloqué lit toujours le document ; seules ses modifications sont refusées.
      const blockedUntil = writers.blocked(context.email);
      if (blockedUntil !== undefined) {
        refuse(connection, context.email, new Refusal(REFUSAL.bloque.code, REFUSAL.bloque.raison, blockedUntil));
        return;
      }

      try {
        const receivedAt = performance.now();
        const seq = await entry.committer.submit(payload, context.email, analysis.chars);
        connection.sendStateless(JSON.stringify({ type: "ack", seq } satisfies ServerMessage));
        latencies.push(performance.now() - receivedAt);
      } catch (error) {
        if (error instanceof Refusal) refuse(connection, context.email, error);
        throw error;
      }
    },

    // Versions (§5) : « enregistrer » = instantané immédiat nommé ; « restaurer » =
    // réappliquer un ancien contenu comme une NOUVELLE modification, écrite dans le
    // journal avant d'être appliquée (comme toute modification), sans débit de crédit.
    async onStateless({ connection, documentName, document, payload }) {
      const entry = open.get(documentName);
      if (!entry) return;
      const writer = (connection.context as Writer).email;
      const reply = (message: ServerMessage) => connection.sendStateless(JSON.stringify(message));
      const isVersionKey = (key: unknown): key is string => typeof key === "string" && key.startsWith(`snapshots/${documentName}/`);
      const readVersion = async (key: string) => {
        const old = new Y.Doc();
        Y.applyUpdate(old, await deps.blobs.get(key));
        return old.getText(TEXT_NAME).toDelta() as Segment[];
      };
      let message: ClientMessage;
      try {
        message = JSON.parse(payload) as ClientMessage;
      } catch {
        return;
      }
      try {
        if (message.type === "apercu") {
          if (!isVersionKey(message.snapshotKey)) {
            reply({ type: "erreur", message: "version inconnue" });
            return;
          }
          reply({ type: "apercu", snapshotKey: message.snapshotKey, delta: await readVersion(message.snapshotKey) });
        } else if (message.type === "enregistrer") {
          const seq = entry.committer.seq; // état et séquence lus ensemble, sans await
          const state = Y.encodeStateAsUpdate(document);
          const label = String(message.label ?? "").trim().slice(0, 80) || "Version sans nom";
          await saveSnapshot(deps.db, deps.blobs, documentName, seq, state, now(), { label, author: writer });
          reply({ type: "version-enregistree", seq, label });
        } else if (message.type === "restaurer") {
          if (!isVersionKey(message.snapshotKey)) {
            reply({ type: "erreur", message: "version inconnue" });
            return;
          }
          const content = await readVersion(message.snapshotKey);
          // Copie de travail de l'état actuel : on y remplace le texte (avec sa mise en
          // forme) et on capture l'update.
          const work = new Y.Doc();
          Y.applyUpdate(work, Y.encodeStateAsUpdate(document));
          const before = Y.encodeStateVector(work);
          const text = work.getText(TEXT_NAME);
          work.transact(() => {
            text.delete(0, text.length);
            text.applyDelta(content);
          });
          const seq = await entry.committer.submit(Y.encodeStateAsUpdate(work, before), writer, 0);
          reply({ type: "restauree", seq });
        }
      } catch (error) {
        deps.log?.error({ error, docId: documentName }, "opération de version impossible");
        reply({ type: "erreur", message: error instanceof Refusal ? error.reason : "opération impossible" });
      }
    },

    // Dernier client parti : on attend les écritures en cours, puis instantané.
    // Le document reste enregistré ici : un client peut se reconnecter pendant ces
    // opérations, et Hocuspocus garde alors le document ouvert.
    async beforeUnloadDocument({ documentName, document }) {
      const entry = open.get(documentName);
      if (!entry) return;
      await entry.committer.drain();
      await entry.compacting;
      await compact(documentName, entry, document);
    },

    // Déchargement effectif seulement. Un nouveau chargement du même document a pu
    // avoir lieu entre-temps : on ne retire que l'entrée du document détruit.
    async afterUnloadDocument({ documentName }) {
      if (open.get(documentName)?.doc.isDestroyed) open.delete(documentName);
    },
  });

  // Présence : un battement par document ouvert toutes les 30 s (TTL 2 min).
  const beat = async () => {
    const at = now();
    await Promise.all(
      [...open].map(([docId, entry]) =>
        deps.db.send(
          new PutCommand({
            TableName: TABLES.presence.tableName,
            Item: {
              docId,
              title: entry.title,
              connected: entry.doc.getConnectionsCount(),
              lastBeat: at,
              ttl: Math.floor(at / 1000) + 120,
            },
          }),
        ),
      ),
    );
  };
  setInterval(() => beat().catch((error: unknown) => deps.log?.error({ error }, "battement de présence")), PRESENCE_INTERVAL_MS).unref();

  let elu = performance.eventLoopUtilization();
  setInterval(() => {
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, elu).utilization;
    elu = current;
    const sorted = latencies.sort((a, b) => a - b);
    latencies = [];
    if (sorted.length === 0) return;
    const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
    deps.log?.info(
      { modifications: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1), boucle: Math.round(utilization * 100), documents: open.size },
      "mesure confirmation",
    );
  }, MEASURE_INTERVAL_MS).unref();

  /** Texte, mise en forme et séquence d'un document ouvert, lus ensemble de façon synchrone (PDF, C3). */
  const openState = (docId: string) => {
    const entry = open.get(docId);
    if (!entry) return undefined;
    const text = entry.doc.getText(TEXT_NAME);
    return { text: text.toString(), delta: text.toDelta() as Segment[], seq: entry.committer.seq };
  };

  return { server, open, openState, beat };
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
