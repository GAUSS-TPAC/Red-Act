/**
 * Éditeur à plusieurs : CodeMirror 6 + Yjs (y-codemirror.next) + provider Hocuspocus.
 *
 * Refus du serveur (CLAUDE.md §5, décisions d'Alan) — avant toute reconnexion, le
 * Y.Doc est DÉTRUIT et un neuf est créé (la copie locale contient la modification
 * refusée ; on repart de l'état du serveur) :
 *   - 4001 crédit épuisé : reconnexion en lecture seule jusqu'à minuit UTC ;
 *   - 4003 bloqué : aucune reconnexion avant la fin du blocage, heure affichée ;
 *   - autres (4400, 4500) : reconnexion simple.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import { basicSetup, EditorView } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { REFUSAL, TEXT_NAME, type ClientMessage, type ServerMessage } from "@editeur/shared/realtime";
import { api, errorText } from "../api.ts";
import { colorFor, formatDateTime, h, mount } from "../dom.ts";
import { session } from "../session.ts";

interface DocInfo {
  docId: string;
  title: string;
  ownerEmail: string;
  editors: string[];
}

interface Version {
  createdAt: string;
  seq: number;
  label: string;
  author: string | null;
  snapshotKey: string;
}

const collabUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;

export function editorPage(root: HTMLElement, docId: string, navigate: (path: string) => void) {
  const me = session()!;
  const { color, light } = colorFor(me.email);

  // --- Éléments de la page
  const title = h("h1", {}, "…");
  const status = h("span", { class: "etat" }, "connexion…");
  const credit = h("span", { class: "discret" });
  const banner = h("div", { class: "bandeau", hidden: true });
  const editorHost = h("div", { class: "editeur" });
  const presence = h("ul", { class: "presence" });
  const editors = h("ul", { class: "liste compacte" });
  const versions = h("ul", { class: "liste compacte" });
  const links = h("ul", { class: "liste compacte" });
  const message = h("p", { class: "discret", role: "status" });

  const showBanner = (text: string | null) => {
    banner.hidden = text === null;
    banner.textContent = text ?? "";
  };

  // --- Connexion temps réel (recréée intégralement après un refus)
  let current: { doc: Y.Doc; provider: HocuspocusProvider; view: EditorView } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let creditTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshCredit = () => {
    clearTimeout(creditTimer);
    creditTimer = setTimeout(async () => {
      try {
        const c = await api<{ remaining: number; limit: number }>("GET", "/api/me/credit");
        credit.textContent = `Crédit restant aujourd'hui : ${c.remaining.toLocaleString("fr-FR")} caractères sur ${c.limit.toLocaleString("fr-FR")}`;
      } catch {}
    }, 800);
  };

  const disconnect = () => {
    if (!current) return;
    current.view.destroy();
    current.provider.destroy();
    current.doc.destroy(); // la copie locale (avec la modification refusée) disparaît
    current = undefined;
  };

  const connect = (readOnly: boolean) => {
    disconnect();
    const doc = new Y.Doc();
    const text = doc.getText(TEXT_NAME);
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: docId,
      document: doc,
      token: me.token,
      onStateless: ({ payload }) => onServerMessage(JSON.parse(payload) as ServerMessage),
      onAuthenticationFailed: () => {
        showBanner("Accès refusé à ce document (vous n'en êtes pas éditeur, ou votre session a expiré).");
        disconnect();
      },
      onStatus: ({ status: s }) => {
        status.textContent = s === "connected" ? "connecté" : s === "connecting" ? "connexion…" : "hors ligne (vos modifications seront envoyées au retour)";
      },
      onUnsyncedChanges: ({ number }) => {
        status.dataset.attente = number > 0 ? "oui" : "non";
        if (number === 0 && status.textContent?.startsWith("connecté")) status.textContent = "connecté — tout est enregistré";
        else if (number > 0) status.textContent = `connecté — ${number} modification(s) en cours d'enregistrement`;
      },
    });
    provider.awareness?.setLocalStateField("user", { name: me.name, email: me.email, color, colorLight: light });
    provider.awareness?.on("change", () => renderPresence(provider));
    renderPresence(provider); // notre propre présence, posée avant l'abonnement

    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          basicSetup,
          keymap.of(yUndoManagerKeymap),
          yCollab(text, provider.awareness, { undoManager }),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ],
      }),
    });
    current = { doc, provider, view };
  };

  const onServerMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "ack":
        refreshCredit();
        break;
      case "refus":
        onRefusal(msg);
        break;
      case "version-enregistree":
        message.textContent = `Version « ${msg.label} » enregistrée.`;
        void loadVersions();
        break;
      case "restauree":
        message.textContent = "Version restaurée : elle est maintenant le contenu du document pour tous.";
        void loadVersions();
        break;
      case "erreur":
        message.textContent = `Opération impossible : ${msg.message}.`;
        break;
    }
  };

  const onRefusal = (msg: Extract<ServerMessage, { type: "refus" }>) => {
    clearTimeout(timer);
    disconnect(); // TOUJOURS avant toute reconnexion
    if (msg.code === REFUSAL.creditEpuise.code) {
      const until = msg.finLe ?? Date.now() + 60_000;
      showBanner(`Crédit du jour épuisé : lecture seule jusqu'au ${formatDateTime(until)} (minuit UTC). Vous voyez toujours les modifications des autres.`);
      connect(true);
      timer = setTimeout(() => (showBanner(null), connect(false)), until - Date.now());
    } else if (msg.code === REFUSAL.bloque.code) {
      const until = msg.finLe ?? Date.now() + 5 * 60 * 60_000;
      showBanner(`Écriture bloquée jusqu'au ${formatDateTime(until)} après plusieurs modifications refusées.`);
      timer = setTimeout(() => (showBanner(null), connect(false)), until - Date.now());
    } else {
      showBanner("Une modification a été refusée ; le document a été rechargé depuis le serveur.");
      connect(false);
      timer = setTimeout(() => showBanner(null), 8_000);
    }
    refreshCredit();
  };

  const renderPresence = (provider: HocuspocusProvider) => {
    const people = new Map<string, { name: string; color: string }>();
    for (const state of provider.awareness?.getStates().values() ?? []) {
      const user = (state as { user?: { name: string; email: string; color: string } }).user;
      if (user) people.set(user.email, user);
    }
    mount(
      presence,
      ...[...people.values()].map((p) => h("li", {}, h("span", { class: "pastille", style: `background:${p.color}` }), p.name)),
    );
  };

  const send = (msg: ClientMessage) => current?.provider.sendStateless(JSON.stringify(msg));

  // --- Panneaux : éditeurs, liens, versions
  const loadInfo = async () => {
    try {
      const info = await api<DocInfo>("GET", `/api/documents/${docId}`);
      title.textContent = info.title;
      document.title = `${info.title} — Éditeur du journal`;
      mount(editors, ...info.editors.map((e) => h("li", {}, e, e === info.ownerEmail ? h("span", { class: "discret" }, " (créateur)") : null)));
    } catch (e) {
      showBanner(errorText(e));
    }
  };

  const loadVersions = async () => {
    try {
      const { versions: list } = await api<{ versions: Version[] }>("GET", `/api/documents/${docId}/versions`);
      mount(
        versions,
        ...(list.length === 0 ? [h("li", { class: "discret" }, "Aucune version encore.")] : []),
        ...list.map((v) =>
          h(
            "li",
            {},
            h("span", {}, v.label === "automatique" ? "Automatique" : v.label),
            h("span", { class: "discret" }, ` — ${formatDateTime(Date.parse(v.createdAt))}${v.author ? `, ${v.author}` : ""} `),
            h(
              "button",
              {
                class: "lien",
                onclick: () => {
                  if (confirm("Restaurer cette version ? Son contenu remplacera le texte actuel pour tous (sans consommer de crédit)."))
                    send({ type: "restaurer", snapshotKey: v.snapshotKey });
                },
              },
              "Restaurer",
            ),
          ),
        ),
      );
    } catch {}
  };

  const shareInput = h("input", { type: "email", required: true, placeholder: "adresse e-mail" });
  const shareForm = h(
    "form",
    {
      class: "ligne",
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          await api("POST", `/api/documents/${docId}/editors`, { email: shareInput.value });
          shareInput.value = "";
          await loadInfo();
        } catch (e) {
          message.textContent = errorText(e);
        }
      },
    },
    shareInput,
    h("button", { type: "submit" }, "Partager"),
  );

  const maxInput = h("input", { type: "number", min: 1, max: 100000, value: "100", required: true, class: "court" });
  const opensInput = h("input", { type: "datetime-local" });
  const linkForm = h(
    "form",
    {
      class: "pile",
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          const body: Record<string, unknown> = { max: Number(maxInput.value) };
          if (opensInput.value) body.opensAt = new Date(opensInput.value).toISOString();
          const link = await api<{ linkId: string; max: number; opensAt: string | null }>("POST", `/api/documents/${docId}/links`, body);
          const url = `${location.origin}/l/${link.linkId}`;
          links.prepend(
            h(
              "li",
              {},
              h("a", { href: url, target: "_blank", rel: "noopener" }, url),
              h("span", { class: "discret" }, ` — ${link.max} téléchargement(s)${link.opensAt ? `, ouvre le ${formatDateTime(Date.parse(link.opensAt))}` : ""} `),
              h("button", { class: "lien", type: "button", onclick: () => void navigator.clipboard?.writeText(url) }, "Copier"),
            ),
          );
        } catch (e) {
          message.textContent = errorText(e);
        }
      },
    },
    h("label", { class: "ligne" }, "Nombre de téléchargements", maxInput),
    h("label", { class: "ligne" }, "Ouverture (facultatif)", opensInput),
    h("button", { type: "submit" }, "Créer un lien PDF"),
  );

  const versionLabel = h("input", { maxLength: 80, placeholder: "Nom de la version" });
  const versionForm = h(
    "form",
    {
      class: "ligne",
      onsubmit: (event: Event) => {
        event.preventDefault();
        send({ type: "enregistrer", label: versionLabel.value });
        versionLabel.value = "";
      },
    },
    versionLabel,
    h("button", { type: "submit" }, "Enregistrer une version"),
  );

  mount(
    root,
    h(
      "header",
      { class: "barre" },
      h("a", { href: "/", onclick: (e: Event) => (e.preventDefault(), navigate("/")) }, "← Mes documents"),
      status,
      credit,
    ),
    banner,
    h(
      "div",
      { class: "plan" },
      h("main", { class: "carte" }, title, editorHost),
      h(
        "aside",
        { class: "carte" },
        h("h2", {}, "Présents"),
        presence,
        h("h2", {}, "Éditeurs"),
        editors,
        shareForm,
        h("h2", {}, "Liens de téléchargement"),
        linkForm,
        links,
        h("h2", {}, "Versions"),
        versionForm,
        versions,
        message,
      ),
    ),
  );

  void loadInfo();
  void loadVersions();
  refreshCredit();
  connect(false);

  return () => {
    clearTimeout(timer);
    clearTimeout(creditTimer);
    disconnect();
  };
}
