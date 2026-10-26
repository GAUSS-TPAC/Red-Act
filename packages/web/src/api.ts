// Appels à l'API (même origine : CloudFront → ALB → instances API).
import { clearSession, session } from "./session.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.erreur ?? `erreur ${status}`));
  }
}

export async function api<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = session()?.token;
  const response = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) {
    clearSession();
    location.assign("/");
  }
  if (!response.ok) throw new ApiError(response.status, json);
  return json as T;
}

/** Messages d'erreur lisibles pour les codes de l'API. */
export function errorText(error: unknown): string {
  const code = error instanceof ApiError ? String(error.body.erreur ?? "") : "";
  return (
    {
      "identite-invalide": "Adresse e-mail invalide.",
      "acces-refuse": "Vous n'êtes pas éditeur de ce document.",
      "document-inconnu": "Document introuvable.",
      "session-invalide": "Session expirée, reconnectez-vous.",
      "titre-invalide": "Le titre ne peut pas être vide.",
      "lien-actif-existant": "Ce document a déjà un lien actif : fermez-le avant d'en créer un autre.",
      "lien-inconnu": "Lien introuvable.",
    }[code] ?? "Une erreur est survenue, réessayez."
  );
}
