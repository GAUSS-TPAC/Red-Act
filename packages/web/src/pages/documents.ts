// Liste des documents dont on est éditeur, création d'un document.
import { api, errorText } from "../api.ts";
import { h, mount } from "../dom.ts";
import { clearSession, session } from "../session.ts";

interface DocumentSummary {
  docId: string;
  title: string;
  ownerEmail: string;
}

export function documentsPage(root: HTMLElement, navigate: (path: string) => void) {
  const me = session()!;
  const list = h("ul", { class: "liste" }, h("li", { class: "discret" }, "Chargement…"));
  const title = h("input", { required: true, maxLength: 200, placeholder: "Titre du document" });
  const error = h("p", { class: "erreur", role: "alert" });

  const load = async () => {
    try {
      const { documents } = await api<{ documents: DocumentSummary[] }>("GET", "/api/documents");
      mount(
        list,
        ...(documents.length === 0 ? [h("li", { class: "discret" }, "Aucun document pour l'instant.")] : []),
        ...documents.map((d) =>
          h(
            "li",
            {},
            h("a", { href: `/doc/${d.docId}`, onclick: (e: Event) => (e.preventDefault(), navigate(`/doc/${d.docId}`)) }, d.title),
            h("span", { class: "discret" }, d.ownerEmail === me.email ? " — vous en êtes le créateur" : ` — créé par ${d.ownerEmail}`),
          ),
        ),
      );
    } catch (e) {
      error.textContent = errorText(e);
    }
  };

  mount(
    root,
    h(
      "header",
      { class: "barre" },
      h("strong", {}, "Éditeur du journal"),
      h(
        "span",
        {},
        `${me.name} (${me.email}) `,
        h("button", { class: "lien", onclick: () => (clearSession(), navigate("/")) }, "Changer d'identité"),
      ),
    ),
    h(
      "main",
      { class: "carte" },
      h("h1", {}, "Mes documents"),
      list,
      h(
        "form",
        {
          class: "ligne",
          onsubmit: async (event: Event) => {
            event.preventDefault();
            try {
              const doc = await api<{ docId: string }>("POST", "/api/documents", { title: title.value });
              navigate(`/doc/${doc.docId}`);
            } catch (e) {
              error.textContent = errorText(e);
            }
          },
        },
        title,
        h("button", { type: "submit" }, "Créer"),
      ),
      error,
    ),
  );
  void load();
  return () => {};
}
