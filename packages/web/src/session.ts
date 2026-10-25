// Identité du rédacteur (nom + e-mail, pas de vrais comptes) gardée dans le navigateur.

export interface Session {
  token: string;
  name: string;
  email: string;
}

const KEY = "editeur-session";

export function getSession(): Session | undefined {
  try {
    const session = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    if (!session) return undefined;
    // Jeton expiré (24 h) : on redemande l'identité plutôt que d'essuyer des 401.
    const payload = JSON.parse(atob(session.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    if (payload.exp !== undefined && payload.exp * 1000 < Date.now()) return undefined;
    return session;
  } catch {
    return undefined;
  }
}

export function setSession(session: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Navigation privée stricte : la session ne durera que le temps de la page.
  }
  current = session;
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  current = undefined;
}

let current: Session | undefined;
/** Session de la page (survit même si le stockage du navigateur est indisponible). */
export const session = () => (current ??= getSession());
