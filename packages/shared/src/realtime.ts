/** Protocole entre le serveur temps réel et les clients (CLAUDE.md §5). */

/** Nom du Y.Text partagé : le seul contenu d'un document. */
export const TEXT_NAME = "contenu";

/**
 * Mise en forme autorisée (éditeur Quill, attributs du Y.Text). Seuls ces formats
 * en ligne existent : le serveur refuse tout autre attribut, et le PDF sait tous les
 * reproduire avec les polices standard de pdfkit. `null`/`false` retirent un format.
 *   font : sans empattement (défaut, Helvetica), « serif » (Times), « monospace » (Courier)
 *   size : normale (défaut), « small », « large », « huge »
 */
export const FORMATS = {
  bold: [true],
  italic: [true],
  underline: [true],
  font: ["serif", "monospace"],
  size: ["small", "large", "huge"],
} as const satisfies Record<string, readonly unknown[]>;

export type FormatName = keyof typeof FORMATS;

export function isAllowedFormat(key: string, value: unknown): boolean {
  if (!Object.hasOwn(FORMATS, key)) return false;
  return value === null || value === false || (FORMATS[key as FormatName] as readonly unknown[]).includes(value);
}

/** Un morceau de texte et sa mise en forme (delta Yjs/Quill). */
export interface Segment {
  insert: string;
  attributes?: Partial<Record<FormatName, unknown>>;
}

/**
 * Refus d'une modification : la connexion au document est fermée. Hocuspocus 4 ne
 * transmet au client que la raison de fermeture (pas de code WebSocket, la socket
 * peut porter plusieurs documents) : le code voyage dans un message « refus »
 * envoyé juste avant, et dans la raison (`"4001 credit-epuise"`).
 */
export const REFUSAL = {
  /** Crédit du jour épuisé : lecture seule jusqu'à minuit UTC. */
  creditEpuise: { code: 4001, raison: "credit-epuise" },
  /** Rédacteur bloqué : pas de reconnexion avant `finLe`. */
  bloque: { code: 4003, raison: "bloque" },
  /** Contenu autre que du texte mis en forme (formats de FORMATS uniquement). */
  contenuInvalide: { code: 4400, raison: "contenu-invalide" },
  /** Écriture impossible (DynamoDB indisponible) : rien n'a été accepté. */
  erreurServeur: { code: 4500, raison: "erreur-serveur" },
} as const;

export type RefusalCode = (typeof REFUSAL)[keyof typeof REFUSAL]["code"];

/** Messages « stateless » envoyés par le serveur (JSON). */
export type ServerMessage =
  /** Modification(s) du client acceptée(s) : écrite(s) dans le journal à `seq`. */
  | { type: "ack"; seq: number }
  /** Refus : le client détruit son Y.Doc avant toute reconnexion. `finLe` en ms epoch. */
  | { type: "refus"; code: RefusalCode; raison: string; finLe?: number }
  /** Version nommée enregistrée (instantané immédiat). */
  | { type: "version-enregistree"; seq: number; label: string }
  /** Version restaurée : appliquée comme une nouvelle modification, écrite à `seq`. */
  | { type: "restauree"; seq: number }
  /** Contenu d'une version, pour l'aperçu avant restauration. */
  | { type: "apercu"; snapshotKey: string; delta: Segment[] }
  | { type: "erreur"; message: string };

/** Messages « stateless » envoyés par le client (JSON). */
export type ClientMessage =
  | { type: "enregistrer"; label: string }
  /** Restaurer = réappliquer le contenu de cet instantané (§5) ; ne consomme pas de crédit. */
  | { type: "restaurer"; snapshotKey: string }
  /** Demande le contenu d'une version (lecture seule). */
  | { type: "apercu"; snapshotKey: string };

/** Clé S3 d'un instantané du document à la séquence `seq`. */
export const snapshotKey = (docId: string, seq: number) => `snapshots/${docId}/${seq}.bin`;

/** Prochain minuit UTC (fin de la lecture seule après un refus 4001), en ms epoch. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
