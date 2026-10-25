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

export type LinkStatus = "actif" | "epuise";

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
}

export interface ReservationItem {
  reservationId: string;
  linkId: string;
  /** Recopié du lien : évite de relire le lien pour délivrer le PDF. */
  docId: string;
  seqRequis: number;
  url?: string;
  urlExpiresAt?: number;
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
