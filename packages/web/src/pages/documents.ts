// Liste des documents dont on est éditeur, création d'un document.
import { api, errorText } from "../api.ts";
import { h, mount } from "../dom.ts";
import { session } from "../session.ts";
import { userMenu } from "./common.ts";

interface DocumentSummary {
  docId: string;
  title: string;
  ownerEmail: string;
}

export function documentsPage(root: HTMLElement, navigate: (path: string) => void) {
  const me = session()!;
  const list = h("ul", { class: "grille-documents" }, h("li", { class: "discret" }, "Chargement…"));
  const title = h("input", { required: true, maxLength: 200, placeholder: "Titre du nouveau document" });
  const error = h("p", { class: "erreur", role: "alert" });

  const load = async () => {
    try {
      const { documents } = await api<{ documents: DocumentSummary[] }>("GET", "/api/documents");
      mount(
        list,
        ...(documents.length === 0 ? [h("li", { class: "discret" }, "Aucun document pour l'instant : créez le premier ci-dessus.")] : []),
        ...documents.map((d) =>
          h(
            "li",
            {},
            h(
              "a",
              { class: "carte-document", href: `/doc/${d.docId}`, onclick: (e: Event) => (e.preventDefault(), navigate(`/doc/${d.docId}`)) },
              h("span", { class: "titre-carte" }, d.title),
              h("span", { class: "discret" }, d.ownerEmail === me.email ? "Vous en êtes le créateur" : `Partagé par ${d.ownerEmail}`),
            ),
          ),
        ),
      );
    } catch (e) {
      error.textContent = errorText(e);
    }
  };

  mount(
    root,
    h("header", { class: "barre" }, h("strong", { class: "marque" }, "Éditeur du journal"), userMenu(me, navigate)),
    h(
      "main",
      { class: "carte" },
      h("h1", {}, "Mes documents"),
      h(
        "form",
        {
          class: "ligne creation",
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
      list,
    ),
  );
  void load();
  return () => {};
}
