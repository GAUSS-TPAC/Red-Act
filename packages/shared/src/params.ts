/** Paramètres SSM (SecureString), créés par le script de déploiement, jamais par le code. */
export const SSM_PARAMS = {
  hmacSecret: "/editeur/hmac-secret",
  adminToken: "/editeur/admin-token",
} as const;

export const PROJECT_TAG = { key: "projet", value: "editeur-partage" } as const;

export const REGION = "eu-north-1";

/** Clé S3 du PDF d'un document à la séquence `seq` (CLAUDE.md §4). */
export const pdfKey = (docId: string, seq: number) => `pdf/${docId}/${seq}.pdf`;

/** Durée de validité des URL pré-signées de téléchargement. */
export const PDF_URL_TTL_SECONDS = 60;

/** Demande de génération de PDF (file SQS `pdf-requests`, CLAUDE.md §7, validée par Alan). */
export interface PdfRequest {
  docId: string;
  /** Le PDF doit contenir au moins les modifications jusqu'à cette séquence. */
  seqRequis: number;
}
