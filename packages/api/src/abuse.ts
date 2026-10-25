/**
 * Anti-abus des visiteurs (CLAUDE.md §8).
 *
 * Compteur EN MÉMOIRE par instance API et par adresse IP, fenêtre de 10 s, seuil
 * 30/N (N = instances API en service, relu toutes les 30 s) : l'ALB répartit les
 * requêtes, chaque instance voit environ 1/N du trafic d'une adresse. Aucune écriture
 * par requête normale ; un dépassement écrit un blocage de 10 min dans DynamoDB
 * (affiché à l'admin, partagé avec les autres instances à la synchronisation).
 * L'adresse vient de `CloudFront-Viewer-Address` (posé par CloudFront, seul client
 * admis par l'ALB), jamais de `X-Forwarded-For` (falsifiable par le visiteur).
 */
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLES } from "@editeur/shared";

export const VISITOR_WINDOW_MS = 10_000;
export const VISITOR_LIMIT = 30;
export const VISITOR_BLOCK_MS = 10 * 60 * 1000;

/** « 198.51.100.7:4321 » ou « 2001:db8::1:4321 » → adresse sans le port. */
export function viewerIp(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const i = value.lastIndexOf(":");
  return i > 0 ? value.slice(0, i) : value;
}

export interface VisitorGuardDeps {
  db: DynamoDBDocumentClient;
  now?: () => number;
  /** Nombre d'instances API en service (1 en local). */
  countInstances?: () => Promise<number>;
  /** Adresses exemptées (instance de test de charge), relues à chaque synchronisation. */
  exemptIps?: () => Promise<string[]>;
  log?: { error: (obj: unknown, msg: string) => void };
}

export class VisitorGuard {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly blocked = new Map<string, number>();
  private instances = 1;
  private exempt = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: VisitorGuardDeps) {
    this.now = deps.now ?? Date.now;
  }

  get limit() {
    return Math.max(1, Math.floor(VISITOR_LIMIT / this.instances));
  }

  /** Une requête de `ip` : undefined si elle passe, sinon la fin du blocage (ms epoch). */
  hit(ip: string): number | undefined {
    if (this.exempt.has(ip)) return undefined;
    const now = this.now();
    const until = this.blocked.get(ip);
    if (until !== undefined) {
      if (until > now) return until;
      this.blocked.delete(ip);
    }
    const entry = this.hits.get(ip);
    if (!entry || now - entry.windowStart >= VISITOR_WINDOW_MS) {
      this.hits.set(ip, { windowStart: now, count: 1 });
      return undefined;
    }
    entry.count++;
    if (entry.count <= this.limit) return undefined;

    const blockedUntil = now + VISITOR_BLOCK_MS;
    this.blocked.set(ip, blockedUntil);
    this.hits.delete(ip);
    void this.deps.db
      .send(
        new PutCommand({
          TableName: TABLES.blocks.tableName,
          Item: {
            subject: `ip#${ip}`,
            reason: `plus de ${this.limit} requêtes en 10 s sur une instance (${this.instances} en service)`,
            expireLe: blockedUntil,
            ttl: Math.floor(blockedUntil / 1000) + 3600,
          },
        }),
      )
      .catch((error: unknown) => this.deps.log?.error({ error, ip }, "écriture du blocage impossible"));
    return blockedUntil;
  }

  /** Toutes les 30 s : N à jour, blocages des autres instances, mémoire bornée. */
  async sync(): Promise<void> {
    const now = this.now();
    if (this.deps.countInstances) this.instances = Math.max(1, await this.deps.countInstances());
    if (this.deps.exemptIps) this.exempt = new Set(await this.deps.exemptIps());
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.deps.db.send(
        new ScanCommand({
          TableName: TABLES.blocks.tableName,
          FilterExpression: "begins_with(subject, :ip) AND expireLe > :now",
          ExpressionAttributeValues: { ":ip": "ip#", ":now": now },
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) this.blocked.set(String(item.subject).slice(3), item.expireLe as number);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    for (const [ip, entry] of this.hits) if (now - entry.windowStart >= VISITOR_WINDOW_MS) this.hits.delete(ip);
    for (const [ip, until] of this.blocked) if (until <= now) this.blocked.delete(ip);
  }

  start(intervalMs = 30_000) {
    const run = () => this.sync().catch((error: unknown) => this.deps.log?.error({ error }, "synchronisation anti-abus"));
    void run();
    return setInterval(run, intervalMs).unref();
  }
}
