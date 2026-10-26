/**
 * Clic sur un lien de téléchargement (CLAUDE.md §6, contraintes C1, C5, C6).
 *
 * Garantie C1 : le seul point qui consomme un exemplaire est l'UpdateItem
 * conditionnel `remaining > 0` sur l'élément du lien. DynamoDB l'exécute de
 * façon atomique : quel que soit le nombre d'instances et de clics simultanés,
 * au plus `max` décréments réussissent. Tout le reste (mémoire « épuisé »,
 * tickets) ne fait qu'éviter du travail, jamais en accorder.
 */
import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createTicket,
  pdfKey,
  PDF_URL_TTL_SECONDS,
  TABLES,
  verifyTicket,
  type DocumentItem,
  type LinkItem,
  type ReservationItem,
} from "@editeur/shared";

/** Délai conseillé avant de réinterroger (en-tête Retry-After). */
export const RETRY_AFTER_SECONDS = 2;

/** Les réservations survivent au ticket (2 min) ; le TTL les nettoie ensuite. */
const RESERVATION_TTL_SECONDS = 60 * 60;

export type ClaimOutcome =
  | { kind: "pret"; url: string; expiresAt: number; ticket?: string }
  | { kind: "patienter"; retryAfter: number; ticket?: string }
  | { kind: "epuise" }
  | { kind: "pas-ouvert"; opensAt: number; retryAfter: number }
  | { kind: "inconnu" };

export interface ClaimDeps {
  db: DynamoDBDocumentClient;
  hmacSecret: string;
  /** URL pré-signée (GET, 60 s) d'une clé S3. */
  presign: (key: string) => Promise<string>;
  /** Demande de génération du PDF au serveur temps réel (étape 4 : SQS). */
  requestPdf: (docId: string, seqRequis: number) => Promise<void>;
  /** Appelé une seule fois, quand le dernier exemplaire est réservé (étape 6 : SES). */
  onLastCopy: (link: LinkItem) => Promise<void>;
  log: { error: (obj: unknown, msg: string) => void };
  now?: () => number;
}

export class ClaimService {
  /** Liens que cette instance sait épuisés : 410 immédiat, sans DynamoDB (C6). */
  private readonly exhausted = new Set<string>();
  /** Liens fermés par un rédacteur (sous-ensemble de `exhausted`) : la fermeture est définitive. */
  private readonly closed = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ClaimDeps) {
    this.now = deps.now ?? Date.now;
  }

  async claim(linkId: string, ticketToken?: string): Promise<ClaimOutcome> {
    const now = this.now();

    // 1. Ticket d'abord : celui qui a réservé le dernier exemplaire doit pouvoir
    //    revenir chercher son PDF même si l'instance sait le lien épuisé.
    if (ticketToken) {
      const ticket = verifyTicket(ticketToken, this.deps.hmacSecret, Math.floor(now / 1000));
      if (ticket.ok && ticket.claims.linkId === linkId) {
        const reservation = await this.getReservation(ticket.claims.reservationId);
        if (reservation && reservation.linkId === linkId) {
          // Exemplaire déjà remis et lien fermé depuis : plus de nouveau téléchargement.
          // Une réservation pas encore servie (202) reste honorée : elle précède la fermeture.
          if (reservation.url && (await this.isClosed(linkId))) return { kind: "epuise" };
          return this.deliver(reservation);
        }
      }
    }

    // 2. Épuisé connu de cette instance.
    if (this.exhausted.has(linkId)) return { kind: "epuise" };

    // 3. Lien, ouverture.
    const link = (await this.deps.db.send(new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId } })))
      .Item as LinkItem | undefined;
    if (!link) return { kind: "inconnu" };
    if (link.status === "epuise" || link.status === "ferme") {
      this.exhausted.add(linkId);
      if (link.status === "ferme") this.closed.add(linkId);
      return { kind: "epuise" };
    }
    if (link.opensAt !== undefined && link.opensAt > now) {
      return {
        kind: "pas-ouvert",
        opensAt: link.opensAt,
        // Au moins 5 s, avec une part aléatoire : les visiteurs arrivés en avance ne
        // reviennent pas tous à la même seconde, et une adresse partagée (NAT d'un
        // campus) ne franchit pas le seuil anti-abus juste avant l'ouverture.
        retryAfter: Math.max(5, Math.min(60, Math.ceil((link.opensAt - now) / 1000))) + Math.floor(Math.random() * 3),
      };
    }

    // 4. Séquence du document AVANT la réservation (C3) : lecture fortement cohérente.
    const doc = await this.getDocument(link.docId);
    if (!doc) return { kind: "inconnu" };

    // 5. Réservation = consommation : décrément atomique conditionnel (C1).
    let remaining: number;
    try {
      const result = await this.deps.db.send(
        new UpdateCommand({
          TableName: TABLES.links.tableName,
          Key: { linkId },
          UpdateExpression: "SET remaining = remaining - :one",
          // `opensAt <= :now` reprend la vérification locale avec la même horloge :
          // un échec ne peut donc venir que d'un stock nul (ou d'un lien supprimé).
          ConditionExpression: "remaining > :zero AND (attribute_not_exists(opensAt) OR opensAt <= :now)",
          ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":now": now },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      remaining = result.Attributes?.remaining as number;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        this.exhausted.add(linkId);
        return { kind: "epuise" };
      }
      throw error;
    }

    const reservation: ReservationItem = {
      reservationId: randomUUID(),
      linkId,
      docId: link.docId,
      seqRequis: doc.seq,
      createdAt: now,
      ttl: Math.floor(now / 1000) + RESERVATION_TTL_SECONDS,
    };
    await this.deps.db.send(new PutCommand({ TableName: TABLES.reservations.tableName, Item: reservation }));

    // Un seul décrément peut faire passer le stock de 1 à 0 : ce bloc ne s'exécute
    // qu'une fois par lien, toutes instances confondues.
    if (remaining === 0) {
      this.exhausted.add(linkId);
      await this.markExhausted(link);
    }

    const ticket = createTicket(
      { linkId, reservationId: reservation.reservationId },
      this.deps.hmacSecret,
      Math.floor(now / 1000),
    );
    const delivered = await this.deliver(reservation, doc);
    return delivered.kind === "inconnu" ? delivered : { ...delivered, ticket };
  }

  /**
   * Délivre l'exemplaire réservé. Une réservation n'a qu'une URL valide à la fois :
   * tant qu'elle n'a pas expiré, on renvoie la même ; une fois expirée (ticket encore
   * valide), on la remplace par une nouvelle sur le même PDF.
   */
  private async deliver(
    reservation: ReservationItem,
    knownDoc?: Pick<DocumentItem, "seq" | "pdfSeq">,
  ): Promise<Exclude<ClaimOutcome, { kind: "epuise" | "pas-ouvert" }>> {
    if (reservation.url && (reservation.urlExpiresAt ?? 0) > this.now()) {
      return { kind: "pret", url: reservation.url, expiresAt: reservation.urlExpiresAt ?? 0 };
    }

    let key = reservation.pdfKey;
    if (!key) {
      const doc = knownDoc ?? (await this.getDocument(reservation.docId));
      if (!doc) return { kind: "inconnu" };
      if (doc.pdfSeq < reservation.seqRequis) {
        try {
          await this.deps.requestPdf(reservation.docId, reservation.seqRequis);
        } catch (error) {
          // La réservation reste acquise : le visiteur réessaiera et la demande sera refaite.
          this.deps.log.error({ error, docId: reservation.docId }, "demande de PDF impossible");
        }
        return { kind: "patienter", retryAfter: RETRY_AFTER_SECONDS };
      }
      key = pdfKey(reservation.docId, doc.pdfSeq);
    }

    const url = await this.deps.presign(key);
    const expiresAt = this.now() + PDF_URL_TTL_SECONDS * 1000;
    // Première URL : « pas encore d'URL ». Renouvellement : « l'URL expirée est toujours
    // celle enregistrée ». Deux retours simultanés : un seul gagne, l'autre relit.
    const renewal = reservation.url !== undefined;
    try {
      await this.deps.db.send(
        new UpdateCommand({
          TableName: TABLES.reservations.tableName,
          Key: { reservationId: reservation.reservationId },
          UpdateExpression: "SET #url = :url, urlExpiresAt = :exp, pdfKey = :key",
          ConditionExpression: renewal ? "urlExpiresAt = :previous" : "attribute_not_exists(#url)",
          ExpressionAttributeNames: { "#url": "url" },
          ExpressionAttributeValues: {
            ":url": url,
            ":exp": expiresAt,
            ":key": key,
            ...(renewal ? { ":previous": reservation.urlExpiresAt ?? 0 } : {}),
          },
        }),
      );
      return { kind: "pret", url, expiresAt };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const stored = await this.getReservation(reservation.reservationId);
      if (!stored?.url) throw error;
      return { kind: "pret", url: stored.url, expiresAt: stored.urlExpiresAt ?? 0 };
    }
  }

  private async markExhausted(link: LinkItem): Promise<void> {
    try {
      await this.deps.db.send(
        new UpdateCommand({
          TableName: TABLES.links.tableName,
          Key: { linkId: link.linkId },
          UpdateExpression: "SET #status = :epuise REMOVE activeFlag",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":epuise": "epuise" },
        }),
      );
      await this.deps.onLastCopy(link);
    } catch (error) {
      // Le stock est déjà à 0 en base : C1 tient même si le marquage échoue.
      this.deps.log.error({ error, linkId: link.linkId }, "marquage du lien épuisé incomplet");
    }
  }

  private async isClosed(linkId: string): Promise<boolean> {
    if (this.closed.has(linkId)) return true;
    const link = (
      await this.deps.db.send(
        new GetCommand({ TableName: TABLES.links.tableName, Key: { linkId }, ConsistentRead: true, ProjectionExpression: "#status", ExpressionAttributeNames: { "#status": "status" } }),
      )
    ).Item as Pick<LinkItem, "status"> | undefined;
    if (link?.status !== "ferme") return false;
    this.closed.add(linkId);
    this.exhausted.add(linkId);
    return true;
  }

  private async getDocument(docId: string) {
    const result = await this.deps.db.send(
      new GetCommand({
        TableName: TABLES.documents.tableName,
        Key: { docId },
        ConsistentRead: true,
        ProjectionExpression: "seq, pdfSeq",
      }),
    );
    return result.Item as Pick<DocumentItem, "seq" | "pdfSeq"> | undefined;
  }

  private async getReservation(reservationId: string) {
    const result = await this.deps.db.send(
      new GetCommand({
        TableName: TABLES.reservations.tableName,
        Key: { reservationId },
        ConsistentRead: true,
      }),
    );
    return result.Item as ReservationItem | undefined;
  }
}
