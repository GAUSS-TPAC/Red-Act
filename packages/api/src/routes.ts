import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ACTIVE_FLAG,
  creditKey,
  createSessionToken,
  DAILY_CREDIT,
  isValidEmail,
  normalizeEmail,
  TABLES,
  verifySessionToken,
  verifyTicket,
  type DocumentItem,
  type LinkItem,
  type SessionClaims,
} from "@editeur/shared";
import { viewerIp, type VisitorGuard } from "./abuse.ts";
import { ClaimService, type ClaimOutcome } from "./links/claim.ts";
import { SCALE_DOWN_AFTER_MS } from "./ops.ts";

export interface RouteDeps {
  db: DynamoDBDocumentClient;
  hmacSecret: string;
  claims: ClaimService;
  /** Préparation du PDF dès la création d'un lien (§6) : premiers clics servis en 200. */
  requestPdf?: (docId: string, seqRequis: number) => Promise<void>;
  /** Anti-abus des visiteurs sur le clic (§8). */
  visitorGuard?: VisitorGuard;
  /** Actions programmées sur l'ASG API autour de `opensAt` (§6, pic). */
  scheduleScaling?: (linkId: string, opensAt: number) => Promise<void>;
  /** Retrait de ces actions quand le lien est fermé avant la fin du pic. */
  unscheduleScaling?: (linkId: string) => Promise<void>;
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

  /** Libère le pointeur de lien actif du document s'il désigne encore `linkId`. */
  const releaseActiveLink = async (docId: string, linkId: string | undefined) => {
    if (!linkId) return;
    await deps.db
      .send(
        new UpdateCommand({
          TableName: TABLES.documents.tableName,
          Key: { docId },
          UpdateExpression: "REMOVE activeLinkId",
          ConditionExpression: "activeLinkId = :id",
          ExpressionAttributeValues: { ":id": linkId },
        }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      });
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

  // --- Lecture pour le front.
  const docParams = {
    type: "object",
    properties: { docId: { type: "string", pattern: ID_PATTERN } },
  } as const;

  const readDocument = async (docId: string) =>
    (
      await deps.db.send(
        new GetCommand({
          TableName: TABLES.documents.tableName,
          Key: { docId },
          ProjectionExpression: "docId, title, ownerEmail, editors, seq",
        }),
      )
    ).Item as Pick<DocumentItem, "docId" | "title" | "ownerEmail" | "editors" | "seq"> | undefined;

  // Documents dont on est éditeur. Scan filtré : simple et suffisant pour le journal
  // d'une association (quelques dizaines de documents) ; un index par éditeur
  // demanderait une table d'appartenance en plus.
  app.get("/api/documents", { preHandler: authenticate }, async (request) => {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.db.send(
        new ScanCommand({
          TableName: TABLES.documents.tableName,
          FilterExpression: "contains(editors, :moi)",
          ExpressionAttributeValues: { ":moi": request.writer!.email },
          ProjectionExpression: "docId, title, ownerEmail",
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return { documents: items.sort((a, b) => String(a.title).localeCompare(String(b.title), "fr")) };
  });

  app.get<{ Params: { docId: string } }>(
    "/api/documents/:docId",
    { preHandler: authenticate, schema: { params: docParams } },
    async (request, reply) => {
      const doc = await readDocument(request.params.docId);
      if (!doc) return reply.code(404).send({ erreur: "document-inconnu" });
      if (!doc.editors.has(request.writer!.email)) return reply.code(403).send({ erreur: "acces-refuse" });
      return { docId: doc.docId, title: doc.title, ownerEmail: doc.ownerEmail, editors: [...doc.editors].sort(), seq: doc.seq };
    },
  );

  // Renommer : tout éditeur, en une écriture conditionnelle (droits vérifiés par DynamoDB).
  app.post<{ Params: { docId: string }; Body: { title: string } }>(
    "/api/documents/:docId/title",
    {
      preHandler: authenticate,
      schema: {
        params: docParams,
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const title = request.body.title.trim();
      if (!title) return reply.code(400).send({ erreur: "titre-invalide" });
      try {
        await deps.db.send(
          new UpdateCommand({
            TableName: TABLES.documents.tableName,
            Key: { docId: request.params.docId },
            UpdateExpression: "SET title = :t",
            ConditionExpression: "attribute_exists(docId) AND contains(editors, :moi)",
            ExpressionAttributeValues: { ":t": title, ":moi": request.writer!.email },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        return (await readDocument(request.params.docId))
          ? reply.code(403).send({ erreur: "acces-refuse" })
          : reply.code(404).send({ erreur: "document-inconnu" });
      }
      return { docId: request.params.docId, title };
    },
  );

  // Liens du document, l'actif puis les plus récents, avec les exemplaires restants (affichage).
  // Scan filtré, comme la liste des documents : quelques liens par document.
  app.get<{ Params: { docId: string } }>(
    "/api/documents/:docId/links",
    { preHandler: authenticate, schema: { params: docParams } },
    async (request, reply) => {
      const doc = await readDocument(request.params.docId);
      if (!doc) return reply.code(404).send({ erreur: "document-inconnu" });
      if (!doc.editors.has(request.writer!.email)) return reply.code(403).send({ erreur: "acces-refuse" });
      const items: LinkItem[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await deps.db.send(
          new ScanCommand({
            TableName: TABLES.links.tableName,
            FilterExpression: "docId = :d",
            ExpressionAttributeValues: { ":d": request.params.docId },
            ConsistentRead: true,
            ExclusiveStartKey,
          }),
        );
        items.push(...((page.Items ?? []) as LinkItem[]));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      const active = (l: LinkItem) => Number(l.status === "actif");
      return { links: items.sort((a, b) => active(b) - active(a) || b.createdAt - a.createdAt).map(linkView) };
    },
  );

  app.get<{ Params: { docId: string } }>(
    "/api/documents/:docId/versions",
    { preHandler: authenticate, schema: { params: docParams } },
    async (request, reply) => {
      const doc = await readDocument(request.params.docId);
      if (!doc) return reply.code(404).send({ erreur: "document-inconnu" });
      if (!doc.editors.has(request.writer!.email)) return reply.code(403).send({ erreur: "acces-refuse" });
      const page = await deps.db.send(
        new QueryCommand({
          TableName: TABLES.versions.tableName,
          KeyConditionExpression: "docId = :d",
          ExpressionAttributeValues: { ":d": request.params.docId },
          ScanIndexForward: false,
          Limit: 50,
        }),
      );
      return {
        versions: (page.Items ?? []).map((v) => ({
          createdAt: new Date(v.createdAt as number).toISOString(),
          seq: v.seq,
          label: v.label,
          author: v.author ?? null,
          snapshotKey: v.snapshotKey,
        })),
      };
    },
  );

  // Crédit du jour (affichage) ; la garantie C4 reste dans la transaction du serveur temps réel.
  app.get("/api/me/credit", { preHandler: authenticate }, async (request) => {
    const item = (
      await deps.db.send(
        new GetCommand({ TableName: TABLES.credits.tableName, Key: { pk: creditKey(request.writer!.email, new Date(now())) } }),
      )
    ).Item;
    const used = (item?.used as number | undefined) ?? 0;
    return { used, remaining: Math.max(0, DAILY_CREDIT - used), limit: DAILY_CREDIT };
  });

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
            ProjectionExpression: "ownerEmail, editors, seq",
          }),
        )
      ).Item as Pick<DocumentItem, "ownerEmail" | "editors" | "seq"> | undefined;
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
      // Un seul lien actif par document (décision d'Alan) : le lien et le pointeur
      // `activeLinkId` du document sont écrits ensemble, à condition qu'aucun lien ne
      // soit en cours. Deux créations simultanées → une seule réussit.
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.db.send(
            new TransactWriteCommand({
              TransactItems: [
                { Put: { TableName: TABLES.links.tableName, Item: link, ConditionExpression: "attribute_not_exists(linkId)" } },
                {
                  Update: {
                    TableName: TABLES.documents.tableName,
                    Key: { docId: link.docId },
                    UpdateExpression: "SET activeLinkId = :id",
                    ConditionExpression: "attribute_not_exists(activeLinkId)",
                    ExpressionAttributeValues: { ":id": link.linkId },
                  },
                },
              ],
            }),
          );
          break;
        } catch (error) {
          if (!(error instanceof TransactionCanceledException) || attempt > 0) throw error;
          if (error.CancellationReasons?.[1]?.Code !== "ConditionalCheckFailed") throw error;
          // Le pointeur peut désigner un lien épuisé (le clic qui prend le dernier
          // exemplaire ne touche pas au document, pour rester minimal) : on le libère.
          const current = (await deps.db.send(new GetCommand({ TableName: TABLES.documents.tableName, Key: { docId: link.docId }, ConsistentRead: true })))
            .Item as DocumentItem | undefined;
          const active = current?.activeLinkId
            ? ((await deps.db.send(new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId: current.activeLinkId }, ConsistentRead: true })))
                .Item as LinkItem | undefined)
            : undefined;
          if (active && active.status === "actif" && active.remaining > 0) {
            return reply.code(409).send({ erreur: "lien-actif-existant", lien: linkView(active) });
          }
          await releaseActiveLink(link.docId, current?.activeLinkId);
        }
      }
      // Pic annoncé : instances API montées 10 min avant l'ouverture (échec non bloquant).
      if (link.opensAt !== undefined) {
        await deps.scheduleScaling?.(link.linkId, link.opensAt).catch((error: unknown) =>
          request.log.error({ error, linkId: link.linkId }, "actions programmées impossibles"),
        );
      }
      // Le PDF de l'état actuel est préparé tout de suite ; un échec n'empêche pas le lien.
      await deps.requestPdf?.(link.docId, doc.seq).catch((error: unknown) =>
        request.log.error({ error, docId: link.docId }, "préparation du PDF impossible"),
      );
      return reply.code(201).send({
        linkId: link.linkId,
        max: link.max,
        opensAt: link.opensAt !== undefined ? new Date(link.opensAt).toISOString() : null,
        claimPath: `/api/links/${link.linkId}/claim`,
      });
    },
  );

  // --- Fermer un lien avant épuisement : stock remis à 0 (les clics suivants reçoivent
  // 410), réservations déjà faites honorées, document libre pour un nouveau lien.
  app.post<{ Params: { linkId: string } }>(
    "/api/links/:linkId/close",
    { preHandler: authenticate, schema: { params: { type: "object", properties: { linkId: { type: "string", pattern: ID_PATTERN } } } } },
    async (request, reply) => {
      const link = (await deps.db.send(new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId: request.params.linkId } })))
        .Item as LinkItem | undefined;
      if (!link) return reply.code(404).send({ erreur: "lien-inconnu" });
      const doc = await readDocument(link.docId);
      if (!doc?.editors.has(request.writer!.email)) return reply.code(403).send({ erreur: "acces-refuse" });
      let closed: LinkItem;
      let closedNow = false;
      try {
        closed = (
          await deps.db.send(
            new UpdateCommand({
              TableName: TABLES.links.tableName,
              Key: { linkId: link.linkId },
              // `closedRemaining` reprend le stock lu dans la même écriture atomique.
              UpdateExpression: "SET #status = :ferme, closedRemaining = remaining, remaining = :zero REMOVE activeFlag",
              ConditionExpression: "#status = :actif",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":ferme": "ferme", ":actif": "actif", ":zero": 0 },
              ReturnValues: "ALL_NEW",
            }),
          )
        ).Attributes as LinkItem;
        closedNow = true;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        closed = (await deps.db.send(new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId: link.linkId }, ConsistentRead: true })))
          .Item as LinkItem;
      }
      await releaseActiveLink(link.docId, link.linkId);
      // Plus de pic à attendre : on retire la montée programmée (échec non bloquant).
      if (closedNow && closed.opensAt !== undefined && closed.opensAt + SCALE_DOWN_AFTER_MS > now()) {
        await deps.unscheduleScaling?.(link.linkId).catch((error: unknown) =>
          request.log.error({ error, linkId: link.linkId }, "retrait des actions programmées impossible"),
        );
      }
      return linkView(closed);
    },
  );

  // --- Clic sur un lien : 200 télécharger / 202 patienter / 410 épuisé.
  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/claim", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { linkId } = request.params;
    if (!new RegExp(ID_PATTERN).test(linkId)) return reply.code(404).send({ etat: "inconnu" });

    // Un visiteur qui a déjà réservé (ticket signé valide pour ce lien) revient chercher
    // son PDF : ses rappels (202) ne comptent pas pour l'anti-abus.
    const ticketToken = readCookie(request.headers.cookie, TICKET_COOKIE);
    const ticket = ticketToken ? verifyTicket(ticketToken, deps.hmacSecret, Math.floor(now() / 1000)) : undefined;
    const hasTicket = ticket?.ok === true && ticket.claims.linkId === linkId;
    const ip = viewerIp(request.headers["cloudfront-viewer-address"]);
    const blockedUntil = ip && !hasTicket ? deps.visitorGuard?.hit(ip) : undefined;
    if (blockedUntil !== undefined) {
      const retryAfter = Math.max(1, Math.ceil((blockedUntil - now()) / 1000));
      return reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ etat: "bloque", finLe: new Date(blockedUntil).toISOString(), retryAfter });
    }

    const outcome = await deps.claims.claim(linkId, ticketToken);
    if ("ticket" in outcome && outcome.ticket) {
      reply.header(
        "Set-Cookie",
        `${TICKET_COOKIE}=${outcome.ticket}; Max-Age=120; Path=/api/links/${linkId}; HttpOnly; Secure; SameSite=Lax`,
      );
    }
    return sendOutcome(reply, outcome);
  });
}

/** Vue d'un lien pour le front : servis = réservations effectivement faites. */
function linkView(link: LinkItem) {
  const restants = link.status === "actif" ? link.remaining : 0;
  return {
    linkId: link.linkId,
    max: link.max,
    remaining: restants,
    served: link.max - link.remaining - (link.closedRemaining ?? 0),
    status: link.status,
    opensAt: link.opensAt !== undefined ? new Date(link.opensAt).toISOString() : null,
    createdAt: new Date(link.createdAt).toISOString(),
  };
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
