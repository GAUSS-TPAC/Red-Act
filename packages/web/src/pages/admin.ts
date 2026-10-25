// Tableau de bord de l'association (§8) : documents ouverts, liens actifs, blocages ;
// rafraîchi toutes les 5 s. Le jeton admin n'est gardé que pour l'onglet en cours.
import { formatDateTime, h, mount } from "../dom.ts";

const KEY = "editeur-admin";
const readToken = () => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

export function adminPage(root: HTMLElement) {
  let token = readToken();
  let timer: ReturnType<typeof setInterval> | undefined;
  const ouverts = h("tbody");
  const liens = h("tbody");
  const blocages = h("tbody");
  const status = h("p", { class: "discret", role: "status" });

  const get = async (path: string) => {
    const response = await fetch(`/api/admin/${path}`, { headers: { "x-admin-token": token } });
    if (response.status === 401) throw new Error("jeton");
    return (await response.json()) as Record<string, Record<string, unknown>[]>;
  };
  const row = (...cells: unknown[]) => h("tr", {}, ...cells.map((c) => h("td", {}, c === null || c === undefined ? "—" : String(c))));

  const refresh = async () => {
    try {
      const [o, l, b] = await Promise.all([get("documents-ouverts"), get("liens-actifs"), get("blocages")]);
      mount(ouverts, ...o.documents!.map((d) => row(d.title, d.connected, formatDateTime(Date.parse(String(d.lastBeat))))));
      mount(
        liens,
        ...l.liens!.map((x) =>
          row(x.linkId, `${x.remaining} / ${x.max}`, x.opensAt ? formatDateTime(Date.parse(String(x.opensAt))) : null, x.creatorEmail),
        ),
      );
      mount(blocages, ...b.blocages!.map((x) => row(x.subject, x.reason, formatDateTime(Date.parse(String(x.expireLe))))));
      status.textContent = `Mis à jour à ${new Date().toLocaleTimeString("fr-FR")} (toutes les 5 s).`;
    } catch (error) {
      if ((error as Error).message === "jeton") {
        clearInterval(timer);
        showLogin("Jeton refusé.");
      } else status.textContent = "Mise à jour impossible, nouvel essai dans 5 s.";
    }
  };

  const table = (headers: string[], body: HTMLElement) =>
    h("table", {}, h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", {}, t)))), body);

  const showBoard = () => {
    mount(
      root,
      h("header", { class: "barre" }, h("strong", {}, "Tableau de bord de l'association"), status),
      h("main", { class: "carte" }, h("h2", {}, "Documents ouverts"), table(["Document", "Connectés", "Dernier signe de vie"], ouverts)),
      h("main", { class: "carte" }, h("h2", {}, "Liens actifs"), table(["Lien", "Restants", "Ouverture", "Créateur"], liens)),
      h("main", { class: "carte" }, h("h2", {}, "Blocages en cours"), table(["Qui", "Raison", "Jusqu'au"], blocages)),
    );
    void refresh();
    timer = setInterval(refresh, 5_000);
  };

  const showLogin = (message = "") => {
    const input = h("input", { type: "password", required: true, autocomplete: "off" });
    mount(
      root,
      h(
        "form",
        {
          class: "carte etroite",
          onsubmit: (event: Event) => {
            event.preventDefault();
            token = input.value;
            try {
              sessionStorage.setItem(KEY, token);
            } catch {}
            showBoard();
          },
        },
        h("h1", {}, "Administration"),
        h("label", {}, "Jeton d'administration", input),
        h("p", { class: "erreur" }, message),
        h("button", { type: "submit" }, "Ouvrir le tableau de bord"),
      ),
    );
  };

  if (token) showBoard();
  else showLogin();
  document.title = "Administration — Éditeur du journal";
  return () => clearInterval(timer);
}
