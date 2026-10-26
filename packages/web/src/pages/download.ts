/**
 * Page de téléchargement d'un lien (C1, C3, C5, C6), sans identité.
 * Le visiteur sait toujours où il en est : télécharge / patiente / épuisé.
 *   200 → téléchargement de l'URL (valable 60 s)
 *   202 → exemplaire réservé, PDF en préparation : on rappelle après Retry-After
 *         (le cookie « ticket » est renvoyé automatiquement : aucun exemplaire en plus)
 *   425 → pas encore ouvert : compte à rebours, puis rappel
 *   410 → épuisé : on N'interroge PLUS jamais (C6)
 *   429 → trop de tentatives depuis cette adresse : attente jusqu'à la fin du blocage
 *   404 → lien inconnu : arrêt ; autre (5xx) → nouvel essai espacé (le visiteur n'est
 *         jamais laissé sans réponse pendant un pic)
 */
import { formatDateTime, h, mount } from "../dom.ts";

export function downloadPage(root: HTMLElement, linkId: string) {
  const state = h("p", { class: "etat-telechargement", role: "status", "aria-live": "polite" });
  const button = h("button", { class: "grand" }, "Télécharger le journal");
  const fallback = h("p", { class: "discret" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;

  const set = (text: string, kind: "attente" | "pret" | "epuise" | "erreur") => {
    state.textContent = text;
    state.dataset.etat = kind;
  };

  const claim = async () => {
    if (stopped) return;
    button.disabled = true;
    let response: Response;
    try {
      response = await fetch(`/api/links/${linkId}/claim`, { method: "POST", credentials: "same-origin" });
    } catch {
      failures++;
      set("Connexion difficile, nouvel essai dans quelques secondes…", "erreur");
      timer = setTimeout(claim, Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4)) * (0.5 + Math.random()));
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      url?: string;
      retryAfter?: number;
      opensAt?: string;
      finLe?: string;
    };
    const retry = (Number(response.headers.get("Retry-After")) || body.retryAfter || 2) * 1000;

    switch (response.status) {
      case 200:
        set("Votre exemplaire est prêt : le téléchargement commence.", "pret");
        mount(fallback, "Si rien ne se passe, ", h("a", { href: body.url! }, "cliquez ici"), " (lien valable une minute).");
        location.assign(body.url!);
        return;
      case 202:
        set("Votre exemplaire est réservé. Préparation du PDF, patientez quelques secondes…", "attente");
        timer = setTimeout(claim, retry);
        return;
      case 425:
        set(`Le téléchargement ouvrira le ${formatDateTime(Date.parse(body.opensAt!))}. Restez sur cette page.`, "attente");
        timer = setTimeout(claim, retry);
        return;
      case 429:
        set(`Trop de tentatives depuis votre connexion. Nouvel essai automatique à ${formatDateTime(Date.parse(body.finLe!))}.`, "erreur");
        timer = setTimeout(claim, retry);
        return;
      case 410:
        stopped = true;
        set("Tous les exemplaires ont été téléchargés. Ce lien est épuisé.", "epuise");
        button.hidden = true;
        return;
      case 404:
        stopped = true;
        set("Ce lien n'existe pas.", "erreur");
        button.hidden = true;
        return;
      default:
        // 5xx (pic, montée en charge) : on réessaie en espaçant, sans jamais abandonner.
        failures++;
        set("Le service est très sollicité, nouvel essai automatique dans quelques secondes…", "attente");
        timer = setTimeout(claim, Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4)) * (0.5 + Math.random()));
        return;
    }
  };

  button.addEventListener("click", () => void claim());
  mount(
    root,
    h(
      "main",
      { class: "carte etroite centre" },
      h("h1", {}, "Journal de l'association"),
      h("p", { class: "discret" }, "Ce lien permet un nombre limité de téléchargements."),
      button,
      state,
      fallback,
    ),
  );
  document.title = "Télécharger le journal";
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
