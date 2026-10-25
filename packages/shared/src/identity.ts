/** Identité des rédacteurs et clés dérivées (CLAUDE.md §8). */

export const DAILY_CREDIT = 10_000;

/** E-mail normalisé : minuscules, sans aucun espace. */
export function normalizeEmail(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

/** Vérification volontairement simple : pas de vrais comptes, seulement une identité. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/** Jour UTC `AAAA-MM-JJ` : la recharge du crédit a lieu à minuit UTC. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Clé de l'élément de crédit du jour : un nouveau jour donne une nouvelle clé. */
export function creditKey(email: string, date: Date = new Date()): string {
  return `${email}#${utcDay(date)}`;
}
