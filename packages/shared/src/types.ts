/** Éléments DynamoDB (CLAUDE.md §9). Dates en millisecondes epoch, TTL en secondes epoch. */

export interface DocumentItem {
  docId: string;
  title: string;
  ownerEmail: string;
  /** Éditeurs invités (le propriétaire est toujours éditeur). */
  editors: Set<string>;
  /** Dernière séquence acceptée du journal. */
  seq: number;
  /** Séquence du dernier PDF complet dans S3 (-1 : aucun PDF encore). */
  pdfSeq: number;
  snapshotSeq: number;
  snapshotKey?: string;
  /** Lien de téléchargement en cours : un seul à la fois par document. */
  activeLinkId?: string;
}

export interface JournalItem {
  docId: string;
  seq: number;
  /** Update Yjs fusionné (`Y.mergeUpdates`) de la fenêtre. */
  update: Uint8Array;
  authors: string[];
  createdAt: number;
  ttl: number;
}

export interface CreditItem {
  /** `email#AAAA-MM-JJ` (jour UTC). */
  pk: string;
  used: number;
  ttl: number;
}

/** « ferme » : arrêté par un rédacteur avant épuisement (stock remis à 0). */
export type LinkStatus = "actif" | "epuise" | "ferme";

export interface LinkItem {
  linkId: string;
  docId: string;
  creatorEmail: string;
  max: number;
  remaining: number;
  opensAt?: number;
  status: LinkStatus;
  /** Présent seulement si le lien est actif (index creux). */
  activeFlag?: string;
  createdAt: number;
  /** Exemplaires non distribués au moment de la fermeture (servis = max − remaining − ce nombre). */
  closedRemaining?: number;
}

export interface ReservationItem {
  reservationId: string;
  linkId: string;
  /** Recopié du lien : évite de relire le lien pour délivrer le PDF. */
  docId: string;
  seqRequis: number;
  /** URL pré-signée en cours ; remplacée seulement après son expiration. */
  url?: string;
  urlExpiresAt?: number;
  /** PDF figé à la première URL : un renouvellement pointe sur le même fichier. */
  pdfKey?: string;
  createdAt: number;
  ttl: number;
}

export type BlockSubject = `writer#${string}` | `ip#${string}`;

export interface BlockItem {
  subject: BlockSubject;
  reason: string;
  expireLe: number;
  ttl: number;
}

export interface PresenceItem {
  docId: string;
  lastBeat: number;
  connected: number;
  ttl: number;
}

export interface VersionItem {
  docId: string;
  createdAt: number;
  snapshotKey: string;
  seq: number;
  label?: string;
  author: string;
}
