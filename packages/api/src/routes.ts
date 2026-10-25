import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ACTIVE_FLAG,
  createSessionToken,
  isValidEmail,
  normalizeEmail,
  TABLES,
  verifySessionToken,
  type DocumentItem,
  type LinkItem,
  type SessionClaims,
} from "@editeur/shared";
import { ClaimService, type ClaimOutcome } from "./links/claim.ts";

export interface RouteDeps {
  db: DynamoDBDocumentClient;
  hmacSecret: string;
  claims: ClaimService;
  now?: () => number;
}

const ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const MAX_COPIES = 100_000;
const TICKET_COOKIE = "ticket";

declare module "fastify" {
  interface FastifyRequest {
    writer?: SessionClaims;
  }
}

/** Lit un cookie sans dépendance supplémentaire. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const now = deps.now ?? Date.now;

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const result = token ? verifySessionToken(token, deps.hmacSecret, Math.floor(now() / 1000)) : undefined;
    if (!result?.ok) return reply.code(401).send({ erreur: "session-invalide" });
    request.writer = { email: result.claims.email, name: result.claims.name };
  };

  // --- Session : un nom et un e-mail suffisent (pas de vrais comptes).
  app.post<{ Body: { name: string; email: string } }>(
    "/api/session",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "email"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            email: { type: "string", minLength: 3, maxLength: 254 },
          },
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const name = request.body.name.trim();
      if (!isValidEmail(email) || !name) return reply.code(400).send({ erreur: "identite-invalide" });
      const token = createSessionToken({ email, name }, deps.hmacSecret, Math.floor(now() / 1000));
      return { token, email, name };
    },
  );

  // --- Documents (création minimale ; liste et édition à l'étape 5).
  app.post<{ Body: { title: string } }>(
    "/api/documents",
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const writer = request.writer!;
      const doc: DocumentItem = {
        docId: randomUUID(),
        title: request.body.title.trim(),
        ownerEmail: writer.email,
        editors: new Set([writer.email]),
        seq: 0,
        pdfSeq: -1,
        snapshotSeq: 0,
      };
      await deps.db.send(
        new PutCommand({
          TableName: TABLES.documents.tableName,
          Item: doc,
          ConditionExpression: "attribute_not_exists(docId)",
        }),
      );
      return reply.code(201).send({ docId: doc.docId, title: doc.title });
    },
  );

  // --- Partage : un éditeur ajoute un autre éditeur (le sujet ne prévoit que des éditeurs).
  app.post<{ Params: { docId: string }; Body: { email: string } }>(
    "/api/documents/:docId/editors",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          properties: { docId: { type: "string", pattern: ID_PATTERN } },
        },
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: { email: { type: "string", minLength: 3, maxLength: 254 } },
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (!isValidEmail(email)) return reply.code(400).send({ erreur: "identite-invalide" });
      try {
        // Vérification des droits et ajout en une seule écriture conditionnelle.
        await deps.db.send(
          new UpdateCommand({
            TableName: TABLES.documents.tableName,
            Key: { docId: request.params.docId },
            UpdateExpression: "ADD editors :nouveau",
            ConditionExpression: "attribute_exists(docId) AND contains(editors, :moi)",
            ExpressionAttributeValues: { ":nouveau": new Set([email]), ":moi": request.writer!.email },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        const exists = (
          await deps.db.send(
            new GetCommand({
              TableName: TABLES.documents.tableName,
              Key: { docId: request.params.docId },
              ProjectionExpression: "docId",
            }),
          )
        ).Item;
        return exists
          ? reply.code(403).send({ erreur: "acces-refuse" })
          : reply.code(404).send({ erreur: "document-inconnu" });
      }
      return { docId: request.params.docId, email };
    },
  );

  // --- Création d'un lien de téléchargement.
  app.post<{ Params: { docId: string }; Body: { max: number; opensAt?: string } }>(
    "/api/documents/:docId/links",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          properties: { docId: { type: "string", pattern: ID_PATTERN } },
        },
        body: {
          type: "object",
          required: ["max"],
          additionalProperties: false,
          properties: {
            max: { type: "integer", minimum: 1, maximum: MAX_COPIES },
            opensAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      const writer = request.writer!;
      const doc = (
        await deps.db.send(
          new GetCommand({
            TableName: TABLES.documents.tableName,
            Key: { docId: request.params.docId },
            ProjectionExpression: "ownerEmail, editors",
          }),
        )
      ).Item as Pick<DocumentItem, "ownerEmail" | "editors"> | undefined;
      if (!doc) return reply.code(404).send({ erreur: "document-inconnu" });
      if (doc.ownerEmail !== writer.email && !doc.editors?.has(writer.email)) {
        return reply.code(403).send({ erreur: "acces-refuse" });
      }

      const link: LinkItem = {
        linkId: randomUUID(),
        docId: request.params.docId,
        creatorEmail: writer.email,
        max: request.body.max,
        remaining: request.body.max,
        status: "actif",
        activeFlag: ACTIVE_FLAG,
        createdAt: now(),
        ...(request.body.opensAt ? { opensAt: Date.parse(request.body.opensAt) } : {}),
      };
      await deps.db.send(
        new PutCommand({
          TableName: TABLES.links.tableName,
          Item: link,
          ConditionExpression: "attribute_not_exists(linkId)",
        }),
      );
      return reply.code(201).send({
        linkId: link.linkId,
        max: link.max,
        opensAt: link.opensAt !== undefined ? new Date(link.opensAt).toISOString() : null,
        claimPath: `/api/links/${link.linkId}/claim`,
      });
    },
  );

  // --- Clic sur un lien : 200 télécharger / 202 patienter / 410 épuisé.
  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/claim", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { linkId } = request.params;
    if (!new RegExp(ID_PATTERN).test(linkId)) return reply.code(404).send({ etat: "inconnu" });

    const outcome = await deps.claims.claim(linkId, readCookie(request.headers.cookie, TICKET_COOKIE));
    if ("ticket" in outcome && outcome.ticket) {
      reply.header(
        "Set-Cookie",
        `${TICKET_COOKIE}=${outcome.ticket}; Max-Age=120; Path=/api/links/${linkId}; HttpOnly; Secure; SameSite=Lax`,
      );
    }
    return sendOutcome(reply, outcome);
  });
}

function sendOutcome(reply: FastifyReply, outcome: ClaimOutcome) {
  switch (outcome.kind) {
    case "pret":
      return reply
        .code(200)
        .send({ etat: "pret", url: outcome.url, expiresAt: new Date(outcome.expiresAt).toISOString() });
    case "patienter":
      return reply
        .code(202)
        .header("Retry-After", String(outcome.retryAfter))
        .send({ etat: "patienter", retryAfter: outcome.retryAfter });
    case "pas-ouvert":
      return reply
        .code(425)
        .header("Retry-After", String(outcome.retryAfter))
        .send({ etat: "pas-ouvert", opensAt: new Date(outcome.opensAt).toISOString(), retryAfter: outcome.retryAfter });
    case "epuise":
      return reply.code(410).send({ etat: "epuise" });
    case "inconnu":
      return reply.code(404).send({ etat: "inconnu" });
  }
}
