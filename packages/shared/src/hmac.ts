/**
 * Jetons signés HMAC-SHA256 : jetons de session et tickets de téléchargement.
 *
 * Format : `base64url(JSON charge utile).base64url(signature)`.
 * La charge utile porte le type de jeton (`k`) : un ticket ne peut pas servir
 * de jeton de session, et inversement, même s'ils partagent le même secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
export const TICKET_TTL_SECONDS = 2 * 60;

/** 32 octets minimum, la taille de la sortie de SHA-256. */
export const MIN_SECRET_BYTES = 32;

export type TokenKind = "session" | "ticket";

export interface SessionClaims {
  email: string;
  name: string;
}

export interface TicketClaims {
  linkId: string;
  reservationId: string;
}

interface ClaimsByKind {
  session: SessionClaims;
  ticket: TicketClaims;
}

export type VerifyFailure = "format" | "signature" | "kind" | "expired";

export type VerifyResult<C> =
  | { ok: true; claims: C & { exp: number } }
  | { ok: false; reason: VerifyFailure };

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(payload: string, secret: string | Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function assertSecret(secret: string | Buffer): void {
  if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error(`Le secret HMAC doit faire au moins ${MIN_SECRET_BYTES} octets`);
  }
}

export function signToken<K extends TokenKind>(
  kind: K,
  claims: ClaimsByKind[K],
  secret: string | Buffer,
  ttlSeconds: number,
  now = nowSeconds(),
): string {
  assertSecret(secret);
  const payload = Buffer.from(JSON.stringify({ ...claims, k: kind, exp: now + ttlSeconds })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export function verifyToken<K extends TokenKind>(
  kind: K,
  token: string,
  secret: string | Buffer,
  now = nowSeconds(),
): VerifyResult<ClaimsByKind[K]> {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "format" };
  const [payload, signature] = parts as [string, string];

  // Signature vérifiée avant toute lecture de la charge utile, à temps constant.
  const expected = sign(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "format" };
  }
  if (typeof decoded !== "object" || decoded === null) return { ok: false, reason: "format" };

  const { k, exp, ...claims } = decoded as Record<string, unknown>;
  if (k !== kind) return { ok: false, reason: "kind" };
  if (typeof exp !== "number") return { ok: false, reason: "format" };
  if (exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, claims: { ...(claims as unknown as ClaimsByKind[K]), exp } };
}

export const createSessionToken = (claims: SessionClaims, secret: string | Buffer, now?: number) =>
  signToken("session", claims, secret, SESSION_TTL_SECONDS, now);

export const verifySessionToken = (token: string, secret: string | Buffer, now?: number) =>
  verifyToken("session", token, secret, now);

export const createTicket = (claims: TicketClaims, secret: string | Buffer, now?: number) =>
  signToken("ticket", claims, secret, TICKET_TTL_SECONDS, now);

export const verifyTicket = (token: string, secret: string | Buffer, now?: number) =>
  verifyToken("ticket", token, secret, now);

/** Comparaison à temps constant de deux chaînes (jeton admin, §8). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "comparaison").update(a).digest();
  const hb = createHmac("sha256", "comparaison").update(b).digest();
  return timingSafeEqual(ha, hb);
}
