/**
 * Écriture des modifications d'un document (CLAUDE.md §5) : c'est ici qu'une
 * modification devient **acceptée**, c'est-à-dire écrite dans DynamoDB.
 *
 * Group commit : une seule transaction à la fois par document, lancée dès que la
 * précédente est terminée, au plus une toutes les 100 ms. Tout ce qui arrive
 * pendant une transaction part dans la suivante, fusionné (`Y.mergeUpdates`) en
 * un seul élément de journal. Une transaction :
 *   - Put   journal  {docId, seq + 1}             (absent)
 *   - Update document seq = seq + 1               (si seq vaut encore la valeur attendue)
 *   - Update crédit  used += n par rédacteur      (si used + n ≤ 10 000)
 * Après succès seulement, l'update fusionné est appliqué à la copie de référence
 * (ce qui le diffuse à tous les clients) et les clients sont confirmés.
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { creditKey, DAILY_CREDIT, REFUSAL, TABLES } from "@editeur/shared";
import * as Y from "yjs";

/** Intervalle minimal entre deux transactions d'un même document (validé par Alan). */
export const MIN_COMMIT_INTERVAL_MS = 100;
/** Les éléments du journal disparaissent seuls ; la compaction passe bien avant. */
export const JOURNAL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Limite DynamoDB de 100 actions : journal + document + 98 crédits. */
export const MAX_WRITERS_PER_TRANSACTION = 98;
/** Au-delà, les modifications en attente sont refusées (rien n'a été accepté). */
const RETRY_DEADLINE_MS = 30_000;

/** Origine des updates appliqués par le serveur (diffusés à tous). */
export const COMMIT_ORIGIN = { source: "commit" } as const;

export class Refusal extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`${code} ${reason}`);
  }
}

interface Pending {
  update: Uint8Array;
  writer: string;
  chars: number;
  resolve: (seq: number) => void;
  reject: (error: Refusal) => void;
}

export interface CommitterDeps {
  db: DynamoDBDocumentClient;
  docId: string;
  /** Copie de référence (le document Hocuspocus). */
  doc: Y.Doc;
  /** `seq` du document au chargement. */
  seq: number;
  now?: () => number;
  /** Appelé de façon synchrone juste après l'application d'un commit (compaction). */
  onCommitted?: (seq: number) => void;
  log?: { error: (obj: unknown, msg: string) => void };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DocumentCommitter {
  private queue: Pending[] = [];
  private loop: Promise<void> | undefined;
  /** Début de la dernière transaction : l'intervalle minimal se compte entre deux débuts. */
  private lastCommitAt = 0;
  private readonly now: () => number;
  /** Dernière séquence écrite ET appliquée à la copie de référence. */
  seq: number;

  constructor(private readonly deps: CommitterDeps) {
    this.now = deps.now ?? Date.now;
    this.seq = deps.seq;
  }

  /** Résout avec la séquence du journal qui contient l'update, ou rejette avec un Refusal. */
  submit(update: Uint8Array, writer: string, chars: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.queue.push({ update, writer, chars, resolve, reject });
      this.loop ??= this.run().finally(() => (this.loop = undefined));
    });
  }

  /** Attend que tout ce qui a été soumis soit écrit ou refusé. */
  async drain(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      const wait = this.lastCommitAt + MIN_COMMIT_INTERVAL_MS - this.now();
      if (wait > 0) await sleep(wait);
      const batch = this.queue;
      this.queue = [];
      try {
        await this.commitBatch(batch);
      } catch (error) {
        this.deps.log?.error({ error, docId: this.deps.docId }, "écriture du journal impossible");
        for (const p of batch) p.reject(new Refusal(REFUSAL.erreurServeur.code, REFUSAL.erreurServeur.raison));
      }
    }
  }

  private async commitBatch(batch: Pending[]): Promise<void> {
    // Un rédacteur = toutes ses modifications du lot, dans une seule transaction.
    const byWriter = new Map<string, Pending[]>();
    for (const p of batch) byWriter.set(p.writer, [...(byWriter.get(p.writer) ?? []), p]);

    let writers = [...byWriter.keys()];
    for (const writer of writers.filter((w) => total(byWriter.get(w)!) > DAILY_CREDIT)) {
      refuseCredit(byWriter.get(writer)!);
    }
    writers = writers.filter((w) => total(byWriter.get(w)!) <= DAILY_CREDIT);

    for (let i = 0; i < writers.length; i += MAX_WRITERS_PER_TRANSACTION) {
      await this.commitGroup(new Map(writers.slice(i, i + MAX_WRITERS_PER_TRANSACTION).map((w) => [w, byWriter.get(w)!])));
    }
  }

  /** Une transaction ; se relance sans les rédacteurs refusés, ou après un conflit. */
  private async commitGroup(group: Map<string, Pending[]>): Promise<void> {
    const deadline = this.now() + RETRY_DEADLINE_MS;
    let attempt = 0;
    while (group.size > 0) {
      const writers = [...group.keys()];
      const pending = writers.flatMap((w) => group.get(w)!);
      const merged = pending.length === 1 ? pending[0]!.update : Y.mergeUpdates(pending.map((p) => p.update));
      const seq = this.seq + 1;
      const now = this.now();
      this.lastCommitAt = now;
      const credited = writers.filter((w) => total(group.get(w)!) > 0);

      try {
        await this.deps.db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: TABLES.journal.tableName,
                  Item: {
                    docId: this.deps.docId,
                    seq,
                    update: merged,
                    authors: writers,
                    createdAt: now,
                    ttl: Math.floor(now / 1000) + JOURNAL_TTL_SECONDS,
                  },
                  ConditionExpression: "attribute_not_exists(seq)",
                },
              },
              {
                Update: {
                  TableName: TABLES.documents.tableName,
                  Key: { docId: this.deps.docId },
                  UpdateExpression: "SET seq = :seq",
                  ConditionExpression: "seq = :expected",
                  ExpressionAttributeValues: { ":seq": seq, ":expected": this.seq },
                },
              },
              ...credited.map((writer) => {
                const n = total(group.get(writer)!);
                return {
                  Update: {
                    TableName: TABLES.credits.tableName,
                    Key: { pk: creditKey(writer, new Date(now)) },
                    UpdateExpression: "SET used = if_not_exists(used, :zero) + :n, #ttl = :ttl",
                    ConditionExpression: "attribute_not_exists(used) OR used <= :max",
                    ExpressionAttributeNames: { "#ttl": "ttl" },
                    ExpressionAttributeValues: {
                      ":zero": 0,
                      ":n": n,
                      ":max": DAILY_CREDIT - n,
                      // Le crédit d'un jour UTC n'a plus d'usage deux jours plus tard.
                      ":ttl": Math.floor(now / 1000) + 2 * 24 * 60 * 60,
                    },
                  },
                };
              }),
            ],
          }),
        );
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) {
          if (this.now() > deadline) throw error;
          await sleep(backoff(attempt++));
          continue;
        }
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === "ConditionalCheckFailed" || reasons[1]?.Code === "ConditionalCheckFailed") {
          // Un autre serveur a écrit ce document : ne doit jamais arriver (un seul
          // serveur temps réel). On refuse tout plutôt que de diverger.
          throw new Error(`séquence ${this.seq} du document ${this.deps.docId} périmée`, { cause: error });
        }
        const refused = credited.filter((_, k) => reasons[2 + k]?.Code === "ConditionalCheckFailed");
        if (refused.length > 0) {
          for (const writer of refused) {
            refuseCredit(group.get(writer)!);
            group.delete(writer);
          }
          continue; // les autres rédacteurs repartent tout de suite
        }
        // TransactionConflict (même crédit écrit pour un autre document en même
        // temps…) : on réessaie sans rien refuser.
        if (this.now() > deadline) throw error;
        await sleep(backoff(attempt++));
        continue;
      }

      // Acceptée : application à la copie de référence (diffusion), puis confirmation.
      this.seq = seq;
      Y.applyUpdate(this.deps.doc, merged, COMMIT_ORIGIN);
      this.deps.onCommitted?.(seq);
      for (const p of pending) p.resolve(seq);
      return;
    }
  }
}

const total = (pending: Pending[]) => pending.reduce((sum, p) => sum + p.chars, 0);

const refuseCredit = (pending: Pending[]) => {
  for (const p of pending) p.reject(new Refusal(REFUSAL.creditEpuise.code, REFUSAL.creditEpuise.raison));
};

/** Délai aléatoire court, croissant, plafonné à 1 s. */
const backoff = (attempt: number) => Math.random() * Math.min(1000, 20 * 2 ** attempt);
