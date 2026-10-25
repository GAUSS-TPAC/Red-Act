/** Paramètres SSM (SecureString), créés par le script de déploiement, jamais par le code. */
export const SSM_PARAMS = {
  hmacSecret: "/editeur/hmac-secret",
  adminToken: "/editeur/admin-token",
} as const;

export const PROJECT_TAG = { key: "projet", value: "editeur-partage" } as const;

export const REGION = "eu-north-1";
