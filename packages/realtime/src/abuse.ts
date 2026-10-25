/**
 * Anti-abus des rédacteurs (CLAUDE.md §8) : 5 refus (4001/4003) en 1 min → blocage
 * de 5 h. Le serveur temps réel est unique : le compteur en mémoire suffit ; le
 * blocage est écrit dans DynamoDB (élément `writer#email`, `expireLe` + TTL) pour
 * survivre à un redémarrage et pour le tableau de bord.
 */
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLES } from "@editeur/shared";

export const WRITER_REFUSALS = 5;
export const WRITER_WINDOW_MS = 60_000;
export const WRITER_BLOCK_MS = 5 * 60 * 60 * 1000;

export class WriterGuard {
  private readonly refusals = new Map<string, number[]>();
  /** Fin de blocage connue par rédacteur (0 : vérifié, pas bloqué). */
  private readonly blockedUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly db: DynamoDBDocumentClient,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** À l'ouverture d'une connexion : relit le blocage éventuel (redémarrage du serveur). */
  async load(writer: string): Promise<void> {
    const item = (
      await this.db.send(
        new GetCommand({ TableName: TABLES.blocks.tableName, Key: { subject: `writer#${writer}` }, ConsistentRead: true }),
      )
    ).Item;
    this.blockedUntil.set(writer, Math.max(this.blockedUntil.get(writer) ?? 0, (item?.expireLe as number | undefined) ?? 0));
  }

  /** Fin du blocage si le rédacteur est bloqué maintenant. */
  blocked(writer: string): number | undefined {
    const until = this.blockedUntil.get(writer) ?? 0;
    return until > this.now() ? until : undefined;
  }

  /** Compte un refus ; renvoie la fin du blocage s'il vient d'être décidé. */
  async record(writer: string): Promise<number | undefined> {
    const now = this.now();
    const recent = (this.refusals.get(writer) ?? []).filter((t) => now - t < WRITER_WINDOW_MS);
    recent.push(now);
    this.refusals.set(writer, recent);
    if (recent.length < WRITER_REFUSALS || this.blocked(writer)) return undefined;

    const until = now + WRITER_BLOCK_MS;
    this.blockedUntil.set(writer, until);
    this.refusals.delete(writer);
    await this.db.send(
      new PutCommand({
        TableName: TABLES.blocks.tableName,
        Item: {
          subject: `writer#${writer}`,
          reason: `${WRITER_REFUSALS} modifications refusées en moins d'une minute`,
          expireLe: until,
          ttl: Math.floor(until / 1000) + 3600,
        },
      }),
    );
    return until;
  }
}
