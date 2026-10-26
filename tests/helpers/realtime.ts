/**
 * Serveur temps réel branché sur DynamoDB Local (instantanés en mémoire) et
 * rédacteurs de test (vrais clients Hocuspocus + Yjs, comme le navigateur).
 */
import { randomUUID } from "node:crypto";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createSessionToken, TABLES, TEXT_NAME, type DocumentItem, type ServerMessage } from "@editeur/shared";
import WebSocket from "ws";
import * as Y from "yjs";
import { createRealtimeServer, type RealtimeDeps } from "../../packages/realtime/src/realtime.ts";
import { memoryBlobStore } from "../../packages/realtime/src/store.ts";
import { TEST_SECRET } from "./local-api.ts";

export async function startRealtime(db: DynamoDBDocumentClient, options: Partial<RealtimeDeps> = {}) {
  const blobs = memoryBlobStore();
  const refusals: { writer: string; code: number }[] = [];
  const { server, open, openState, beat } = createRealtimeServer({
    db,
    blobs,
    hmacSecret: TEST_SECRET,
    port: 0,
    onRefusal: (writer, code) => refusals.push({ writer, code }),
    ...options,
  });
  await server.listen();
  return { server, open, openState, beat, blobs, refusals, url: `ws://127.0.0.1:${server.address.port}/collab` };
}

export async function createDocument(db: DynamoDBDocumentClient, editors: string[]): Promise<string> {
  const doc: DocumentItem = {
    docId: randomUUID(),
    title: "Test temps réel",
    ownerEmail: editors[0]!,
    editors: new Set(editors),
    seq: 0,
    pdfSeq: -1,
    snapshotSeq: 0,
  };
  await db.send(new PutCommand({ TableName: TABLES.documents.tableName, Item: doc }));
  return doc.docId;
}

/** Un rédacteur connecté à un document, avec la mesure de ses confirmations. */
export class TestWriter {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText(TEXT_NAME);
  readonly provider: HocuspocusProvider;
  /** Une socket par rédacteur : chacun est un appareil distinct. */
  readonly socket: HocuspocusProviderWebsocket;
  /** Séquences de journal confirmées (message « ack »), dans l'ordre. */
  readonly acks: number[] = [];
  /** Retard de confirmation de chaque modification : envoi → ack. */
  readonly confirmations: { sentAt: number; ms: number }[] = [];
  refusal: Extract<ServerMessage, { type: "refus" }> | undefined;
  /** Autres messages du serveur (versions, erreurs). */
  readonly messages: ServerMessage[] = [];
  closedReason: string | undefined;
  /** Heures des modifications locales pas encore parties. */
  private readonly unsent: number[] = [];
  /** Un groupe par message « update » envoyé (une modification, ou plusieurs si regroupées). */
  private readonly sentGroups: number[][] = [];

  /**
   * `token` : jeton de session (testToken en local, POST /api/session sur AWS).
   * `flushDelay` : regroupement côté client, comme l'éditeur (CLAUDE.md §5) ; le retard
   * de confirmation reste mesuré par frappe, depuis la frappe elle-même.
   */
  constructor(url: string, docId: string, token: string, options: { flushDelay?: number } = {}) {
    this.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider) this.unsent.push(performance.now());
    });
    this.socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: docId,
      document: this.doc,
      token,
      flushDelay: options.flushDelay ?? false,
      // Le serveur confirme chaque message « update » : on rattache à chaque message
      // les frappes qu'il emporte.
      onOutgoingMessage: ({ message }) => {
        if (message.description === "A document update" && this.unsent.length > 0) this.sentGroups.push(this.unsent.splice(0));
      },
      onStateless: ({ payload }) => {
        const message = JSON.parse(payload) as ServerMessage;
        if (message.type === "ack") {
          this.acks.push(message.seq);
          const now = performance.now();
          for (const sentAt of this.sentGroups.shift() ?? []) this.confirmations.push({ sentAt, ms: now - sentAt });
        } else if (message.type === "refus") {
          this.refusal = message;
        } else {
          this.messages.push(message);
        }
      },
      onClose: ({ event }) => {
        this.closedReason ??= event.reason;
      },
    });
    // Socket fournie par nous : le provider ne s'y attache pas tout seul.
    this.provider.attach();
  }

  synced(timeoutMs = 10_000): Promise<void> {
    return waitFor(() => this.provider.synced, timeoutMs, "synchronisation initiale");
  }

  /** Une transaction Yjs = un message envoyé au serveur. */
  insert(index: number, content: string) {
    this.text.insert(Math.min(index, this.text.length), content);
  }

  /** Toutes les modifications envoyées sont confirmées (ou la connexion a été fermée). */
  idle(timeoutMs = 30_000): Promise<void> {
    return waitFor(() => !this.provider.hasUnsyncedChanges || this.refusal !== undefined, timeoutMs, "confirmations");
  }

  destroy() {
    this.provider.destroy();
    this.socket.destroy();
    this.doc.destroy();
  }
}

/** Jeton de session signé avec le secret de test (serveur local uniquement). */
export const testToken = (email: string) => createSessionToken({ email, name: email.split("@")[0]! }, TEST_SECRET);

export async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Vecteur d'état lisible (client → horloge), pour comparer des copies. */
export const stateVector = (doc: Y.Doc) =>
  Object.fromEntries([...Y.decodeStateVector(Y.encodeStateVector(doc))].sort(([a], [b]) => a - b));
