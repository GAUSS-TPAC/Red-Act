/**
 * Tableau de bord de l'association (CLAUDE.md §8) : `/api/admin/*`, protégé par un
 * jeton (SSM `/editeur/admin-token`) comparé à temps constant.
 *   - documents ouverts : battements du serveur temps réel (< 90 s) ;
 *   - liens actifs et exemplaires restants : index creux `liens-actifs` ;
 *   - blocages en cours : filtrés sur `expireLe > maintenant` (le TTL supprime en retard).
 */
import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { FastifyInstance } from "fastify";
import { ACTIVE_FLAG, safeEqual, TABLES } from "@editeur/shared";

/** Un document est « ouvert » si son dernier battement (toutes les 30 s) a moins de 90 s. */
export const PRESENCE_FRESH_MS = 90_000;

export function registerAdmin(
  app: FastifyInstance,
  deps: { db: DynamoDBDocumentClient; adminToken: string; now?: () => number },
) {
  const now = deps.now ?? Date.now;

  const scanAll = async (input: ConstructorParameters<typeof ScanCommand>[0]) => {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.db.send(new ScanCommand({ ...input, ExclusiveStartKey }));
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        const token = request.headers["x-admin-token"];
        if (typeof token !== "string" || !safeEqual(token, deps.adminToken)) {
          return reply.code(401).header("Cache-Control", "no-store").send({ erreur: "jeton-admin-invalide" });
        }
        reply.header("Cache-Control", "no-store");
      });

      admin.get("/documents-ouverts", async () => {
        const items = await scanAll({
          TableName: TABLES.presence.tableName,
          FilterExpression: "lastBeat > :since",
          ExpressionAttributeValues: { ":since": now() - PRESENCE_FRESH_MS },
        });
        return {
          documents: items
            .map((d) => ({ docId: d.docId, title: d.title, connected: d.connected, lastBeat: new Date(d.lastBeat as number).toISOString() }))
            .sort((a, b) => Number(b.connected) - Number(a.connected)),
        };
      });

      admin.get("/liens-actifs", async () => {
        const items: Record<string, unknown>[] = [];
        let ExclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const page = await deps.db.send(
            new QueryCommand({
              TableName: TABLES.links.tableName,
              IndexName: "liens-actifs",
              KeyConditionExpression: "activeFlag = :a",
              ExpressionAttributeValues: { ":a": ACTIVE_FLAG },
              ExclusiveStartKey,
            }),
          );
          items.push(...(page.Items ?? []));
          ExclusiveStartKey = page.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return {
          liens: items.map((l) => ({
            linkId: l.linkId,
            docId: l.docId,
            creatorEmail: l.creatorEmail,
            max: l.max,
            remaining: l.remaining,
            opensAt: l.opensAt !== undefined ? new Date(l.opensAt as number).toISOString() : null,
          })),
        };
      });

      admin.get("/blocages", async () => {
        const items = await scanAll({
          TableName: TABLES.blocks.tableName,
          FilterExpression: "expireLe > :now",
          ExpressionAttributeValues: { ":now": now() },
        });
        return {
          blocages: items
            .map((b) => ({ subject: b.subject, reason: b.reason, expireLe: new Date(b.expireLe as number).toISOString() }))
            .sort((a, b) => a.expireLe.localeCompare(b.expireLe)),
        };
      });
    },
    { prefix: "/api/admin" },
  );
}
