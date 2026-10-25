/**
 * Page de téléchargement d'un lien (C1, C3, C5, C6), sans identité.
 * Le visiteur sait toujours où il en est : télécharge / patiente / épuisé.
 *   200 → téléchargement de l'URL (valable 60 s)
 *   202 → exemplaire réservé, PDF en préparation : on rappelle après Retry-After
 *         (le cookie « ticket » est renvoyé automatiquement : aucun exemplaire en plus)
 *   425 → pas encore ouvert : compte à rebours, puis rappel
 *   410 → épuisé : on N'interroge PLUS jamais (C6)
 *   429 → trop de tentatives depuis cette adresse : attente jusqu'à la fin du blocage
 */
import { formatDateTime, h, mount } from "../dom.ts";

export function downloadPage(root: HTMLElement, linkId: string) {
  const state = h("p", { class: "etat-telechargement", role: "status", "aria-live": "polite" });
  const button = h("button", { class: "grand" }, "Télécharger le journal");
  const fallback = h("p", { class: "discret" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

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
      set("Connexion difficile, nouvel essai dans quelques secondes…", "erreur");
      timer = setTimeout(claim, 3_000);
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
      default:
        stopped = true;
        set("Ce lien n'existe pas.", "erreur");
        button.hidden = true;
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
