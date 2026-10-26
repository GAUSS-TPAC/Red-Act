/**
 * Éditeur à plusieurs : Quill 2 + Yjs (y-quill) + provider Hocuspocus.
 * Mise en forme (barre latérale) : gras, italique, souligné, 3 polices, 4 tailles —
 * exactement les formats admis par le serveur et reproduits dans le PDF (FORMATS).
 *
 * Refus du serveur (CLAUDE.md §5, décisions d'Alan) — avant toute reconnexion, le
 * Y.Doc est DÉTRUIT et un neuf est créé (la copie locale contient la modification
 * refusée ; on repart de l'état du serveur) :
 *   - 4001 crédit épuisé : reconnexion en lecture seule jusqu'à minuit UTC ;
 *   - 4003 bloqué : aucune reconnexion avant la fin du blocage, heure affichée ;
 *   - autres (4400, 4500) : reconnexion simple.
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import Quill from "quill";
import QuillCursors from "quill-cursors";
import { QuillBinding } from "y-quill";
import * as Y from "yjs";
import { FORMATS, REFUSAL, TEXT_NAME, type ClientMessage, type Segment, type ServerMessage } from "@editeur/shared/realtime";
import { api, errorText } from "../api.ts";
import { colorFor, formatDateTime, h, mount } from "../dom.ts";
import { session } from "../session.ts";
import { userMenu } from "./common.ts";

Quill.register("modules/cursors", QuillCursors);

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

interface LinkView {
  linkId: string;
  max: number;
  remaining: number;
  served: number;
  status: "actif" | "epuise" | "ferme";
  opensAt: string | null;
  createdAt: string;
}

const collabUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
const linkUrl = (linkId: string) => `${location.origin}/l/${linkId}`;
const QUILL_FORMATS = Object.keys(FORMATS);
const LINK_REFRESH_MS = 5_000;
const FLUSH_DELAY_MS = 200;

/** Barre de mise en forme (Quill la branche sur ses boutons par leurs classes ql-*). */
function formatToolbar() {
  const select = (format: string, options: [value: string, label: string][]) =>
    h(
      "select",
      { class: `ql-${format}`, title: format === "font" ? "Police" : "Taille" },
      ...options.map(([value, label]) => h("option", value ? { value } : { selected: true }, label)),
    );
  const button = (format: string, label: string, shortcut: string) =>
    h("button", { class: `ql-${format}`, type: "button", title: `${label} (${shortcut})`, "aria-label": label });
  return h(
    "div",
    { class: "outils-format" },
    h("p", { class: "titre-outils" }, "Police"),
    select("font", [["", "Sans empattement"], ["serif", "Avec empattement"], ["monospace", "Chasse fixe"]]),
    h("p", { class: "titre-outils" }, "Taille"),
    select("size", [["small", "Petite"], ["", "Normale"], ["large", "Grande"], ["huge", "Très grande"]]),
    h("p", { class: "titre-outils" }, "Style"),
    h("div", { class: "boutons-format" }, button("bold", "Gras", "Ctrl+B"), button("italic", "Italique", "Ctrl+I"), button("underline", "Souligné", "Ctrl+U")),
  );
}

export function editorPage(root: HTMLElement, docId: string, navigate: (path: string) => void) {
  const me = session()!;
  const { color, light } = colorFor(me.email);

  // --- Éléments de la page
  const titleInput = h("input", { class: "titre-document", maxLength: 200, "aria-label": "Titre du document", value: "…" });
  const status = h("span", { class: "etat" }, "connexion…");
  const credit = h("span", { class: "credit" });
  const banner = h("div", { class: "bandeau", hidden: true });
  const toolsAside = h("aside", { class: "outils carte", "aria-label": "Mise en forme" });
  const editorHost = h("div", { class: "feuille" });
  const presence = h("ul", { class: "presence" });
  const editors = h("ul", { class: "liste compacte" });
  const linkPanel = h("div", { class: "lien-panneau" });
  const message = h("p", { class: "discret message", role: "status" });

  const showBanner = (text: string | null) => {
    banner.hidden = text === null;
    banner.textContent = text ?? "";
  };
  const say = (text: string) => {
    message.textContent = text;
  };

  // --- Connexion temps réel (recréée intégralement après un refus)
  let current: { doc: Y.Doc; provider: HocuspocusProvider; quill: Quill; binding: QuillBinding } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let creditTimer: ReturnType<typeof setTimeout> | undefined;
  let linkTimer: ReturnType<typeof setInterval> | undefined;

  const refreshCredit = () => {
    clearTimeout(creditTimer);
    creditTimer = setTimeout(async () => {
      try {
        const c = await api<{ remaining: number; limit: number }>("GET", "/api/me/credit");
        credit.textContent = `Crédit du jour : ${c.remaining.toLocaleString("fr-FR")} / ${c.limit.toLocaleString("fr-FR")} caractères`;
        credit.dataset.bas = c.remaining < c.limit / 10 ? "oui" : "non";
      } catch {}
    }, 800);
  };

  const disconnect = () => {
    if (!current) return;
    current.binding.destroy();
    current.provider.destroy();
    current.doc.destroy(); // la copie locale (avec la modification refusée) disparaît
    editorHost.replaceChildren();
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
      // Regroupement côté client (prévu par Alan si le retard de confirmation se
      // dégrade, CLAUDE.md §5) : le serveur traite les messages d'une connexion un par
      // un, une transaction DynamoDB chacun ; à 8 frappes/s, un message par frappe
      // faisait la queue (≈ 1,1 s de médiane sur AWS, test C2 du 26/10). Les frappes
      // de 200 ms partent fusionnées en un seul message (≤ 5 messages/s).
      flushDelay: FLUSH_DELAY_MS,
      onStateless: ({ payload }) => onServerMessage(JSON.parse(payload) as ServerMessage),
      onAuthenticationFailed: () => {
        showBanner("Accès refusé à ce document (vous n'en êtes pas éditeur, ou votre session a expiré).");
        disconnect();
      },
      onStatus: ({ status: s }) => {
        status.dataset.etat = s;
        status.textContent = s === "connected" ? "Connecté" : s === "connecting" ? "Connexion…" : "Hors ligne : vos modifications partiront au retour";
      },
      onUnsyncedChanges: ({ number }) => {
        if (status.dataset.etat !== "connected") return;
        status.textContent = number > 0 ? "Enregistrement…" : "Tout est enregistré";
      },
    });
    provider.awareness?.setLocalStateField("user", { name: me.name, email: me.email, color, colorLight: light });
    provider.awareness?.on("change", () => renderPresence(provider));
    renderPresence(provider); // notre propre présence, posée avant l'abonnement

    // Barre neuve à chaque connexion : Quill attache ses gestionnaires à ses boutons.
    const toolbar = formatToolbar();
    toolbar.classList.toggle("inactif", readOnly);
    toolsAside.replaceChildren(toolbar);
    const host = h("div", {});
    editorHost.append(host);
    const quill = new Quill(host, {
      theme: "snow",
      formats: QUILL_FORMATS,
      placeholder: "Commencez à écrire…",
      readOnly,
      modules: {
        toolbar: { container: toolbar },
        cursors: { transformOnTextChange: true },
        history: { userOnly: true }, // Ctrl+Z n'annule que ses propres modifications
      },
    });
    const binding = new QuillBinding(text, quill, provider.awareness ?? undefined);
    current = { doc, provider, quill, binding };
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
        say(`Version « ${msg.label} » enregistrée.`);
        if (versionsDialog.open) void loadVersions();
        break;
      case "restauree":
        say("Version restaurée : c'est maintenant le contenu du document pour tous.");
        versionsDialog.close();
        break;
      case "apercu":
        if (msg.snapshotKey === selectedVersion?.snapshotKey) showPreview(msg.delta);
        break;
      case "erreur":
        say(`Opération impossible : ${msg.message}.`);
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
      ...[...people.values()].map((p) =>
        h("li", { title: p.name }, h("span", { class: "avatar petit", style: `background:${p.color}` }, p.name.slice(0, 1).toUpperCase()), p.name),
      ),
    );
  };

  const send = (msg: ClientMessage) => current?.provider.sendStateless(JSON.stringify(msg));

  // --- Titre : modifiable sur place, enregistré à la validation ou en quittant le champ.
  let savedTitle = "";
  const saveTitle = async () => {
    const title = titleInput.value.trim();
    if (!title || title === savedTitle) {
      titleInput.value = savedTitle;
      return;
    }
    try {
      await api("POST", `/api/documents/${docId}/title`, { title });
      savedTitle = title;
      document.title = `${title} — Éditeur du journal`;
      say("Titre enregistré.");
    } catch (e) {
      titleInput.value = savedTitle;
      say(errorText(e));
    }
  };
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleInput.blur();
    if (e.key === "Escape") (titleInput.value = savedTitle), titleInput.blur();
  });
  titleInput.addEventListener("blur", () => void saveTitle());

  // --- Éditeurs
  const loadInfo = async () => {
    try {
      const info = await api<DocInfo>("GET", `/api/documents/${docId}`);
      if (document.activeElement !== titleInput) titleInput.value = info.title;
      savedTitle = info.title;
      document.title = `${info.title} — Éditeur du journal`;
      mount(editors, ...info.editors.map((e) => h("li", {}, e, e === info.ownerEmail ? h("span", { class: "discret" }, " (créateur)") : null)));
    } catch (e) {
      showBanner(errorText(e));
    }
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
          say(errorText(e));
        }
      },
    },
    shareInput,
    h("button", { type: "submit" }, "Partager"),
  );

  // --- Lien de téléchargement : un seul actif par document, compteur rafraîchi.
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
          await api("POST", `/api/documents/${docId}/links`, body);
          opensInput.value = "";
        } catch (e) {
          say(errorText(e));
        }
        await loadLinks();
      },
    },
    h("label", { class: "ligne" }, "Exemplaires", maxInput),
    h("label", {}, "Ouverture (facultatif)", opensInput),
    h("button", { type: "submit" }, "Créer le lien PDF"),
  );

  const statusLabel = { actif: "actif", epuise: "épuisé", ferme: "fermé" } as const;

  const renderLinks = (links: LinkView[]) => {
    const active = links.find((l) => l.status === "actif");
    const past = links.filter((l) => l !== active);
    const activeBlock = active
      ? h(
          "div",
          { class: "lien-actif" },
          h(
            "div",
            { class: "ligne" },
            h("input", { readOnly: true, value: linkUrl(active.linkId), "aria-label": "Adresse du lien", onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
            h(
              "button",
              {
                type: "button",
                class: "secondaire",
                onclick: () => {
                  void navigator.clipboard?.writeText(linkUrl(active.linkId));
                  say("Lien copié.");
                },
              },
              "Copier",
            ),
          ),
          h("div", { class: "jauge", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": active.max, "aria-valuenow": active.remaining },
            h("span", { style: `width:${(100 * active.remaining) / active.max}%` }),
          ),
          h("p", { class: "compteur" }, h("strong", {}, active.remaining.toLocaleString("fr-FR")), ` exemplaire(s) restant(s) sur ${active.max.toLocaleString("fr-FR")}`),
          active.opensAt && Date.parse(active.opensAt) > Date.now()
            ? h("p", { class: "discret" }, `Ouvre le ${formatDateTime(Date.parse(active.opensAt))}`)
            : null,
          h(
            "button",
            {
              type: "button",
              class: "danger",
              onclick: async () => {
                if (!confirm("Fermer ce lien ? Les visiteurs suivants verront « épuisé » ; vous pourrez en créer un nouveau.")) return;
                try {
                  await api("POST", `/api/links/${active.linkId}/close`);
                } catch (e) {
                  say(errorText(e));
                }
                await loadLinks();
              },
            },
            "Fermer le lien",
          ),
        )
      : linkForm;
    mount(
      linkPanel,
      activeBlock,
      past.length
        ? h(
            "details",
            { class: "historique" },
            h("summary", {}, `Liens précédents (${past.length})`),
            h(
              "ul",
              { class: "liste compacte" },
              ...past.map((l) =>
                h("li", {}, `${formatDateTime(Date.parse(l.createdAt))} — ${statusLabel[l.status]}, ${l.served.toLocaleString("fr-FR")} / ${l.max.toLocaleString("fr-FR")} téléchargé(s)`),
              ),
            ),
          )
        : null,
    );
  };

  let lastLinks = "";
  const loadLinks = async () => {
    try {
      const { links } = await api<{ links: LinkView[] }>("GET", `/api/documents/${docId}/links`);
      const key = JSON.stringify(links);
      if (key !== lastLinks || !linkPanel.firstChild) {
        lastLinks = key;
        renderLinks(links);
      }
    } catch {}
  };

  // --- Versions : fenêtre de choix, aperçu en lecture seule, puis restauration.
  const versionList = h("ul", { class: "versions-liste" });
  const previewHost = h("div", { class: "apercu-contenu" });
  const previewTitle = h("h3", {}, "Choisissez une version");
  const restoreButton = h("button", { type: "button", disabled: true }, "Restaurer cette version");
  const versionLabel = h("input", { maxLength: 80, placeholder: "Nom de la version (ex. « relu par Léa »)" });
  let selectedVersion: Version | undefined;
  let previewQuill: Quill | undefined;

  const showPreview = (delta: Segment[]) => {
    previewQuill ??= new Quill(h("div", {}), { theme: "snow", readOnly: true, formats: QUILL_FORMATS, modules: { toolbar: false } });
    previewHost.replaceChildren(previewQuill.root.parentElement!);
    previewQuill.setContents(delta.length ? delta : [{ insert: "(document vide)\n" }]);
    restoreButton.disabled = false;
  };

  const versionName = (v: Version) => (v.label === "automatique" ? "Enregistrement automatique" : v.label);

  const selectVersion = (v: Version, item: HTMLElement) => {
    selectedVersion = v;
    for (const li of versionList.children) li.classList.toggle("choisie", li === item);
    previewTitle.textContent = `${versionName(v)} — ${formatDateTime(Date.parse(v.createdAt))}`;
    previewHost.replaceChildren(h("p", { class: "discret" }, "Chargement de l'aperçu…"));
    restoreButton.disabled = true;
    send({ type: "apercu", snapshotKey: v.snapshotKey });
  };

  const loadVersions = async () => {
    try {
      const { versions: list } = await api<{ versions: Version[] }>("GET", `/api/documents/${docId}/versions`);
      mount(
        versionList,
        ...(list.length === 0 ? [h("li", { class: "discret vide" }, "Aucune version encore.")] : []),
        ...list.map((v) => {
          const item: HTMLElement = h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: "version", onclick: () => selectVersion(v, item) },
              h("span", { class: v.label === "automatique" ? "nom-version discret" : "nom-version" }, versionName(v)),
              h("span", { class: "date-version" }, `${formatDateTime(Date.parse(v.createdAt))}${v.author ? ` · ${v.author}` : ""}`),
            ),
          );
          return item;
        }),
      );
    } catch {}
  };

  restoreButton.addEventListener("click", () => {
    if (!selectedVersion) return;
    if (confirm("Restaurer cette version ? Son contenu remplacera le texte actuel pour tous (sans consommer de crédit)."))
      send({ type: "restaurer", snapshotKey: selectedVersion.snapshotKey });
  });

  const versionsDialog = h(
    "dialog",
    { class: "fenetre-versions", "aria-labelledby": "titre-versions" },
    h(
      "div",
      { class: "entete-fenetre" },
      h("h2", { id: "titre-versions" }, "Historique des versions"),
      h("button", { type: "button", class: "fermer", "aria-label": "Fermer", onclick: () => versionsDialog.close() }, "×"),
    ),
    h(
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
      h("button", { type: "submit" }, "Enregistrer la version actuelle"),
    ),
    h(
      "div",
      { class: "corps-versions" },
      versionList,
      h("section", { class: "apercu" }, previewTitle, previewHost, h("div", { class: "actions" }, restoreButton)),
    ),
  );
  versionsDialog.addEventListener("click", (e) => {
    if (e.target === versionsDialog) versionsDialog.close(); // clic sur le fond
  });

  const openVersions = () => {
    selectedVersion = undefined;
    previewTitle.textContent = "Choisissez une version";
    previewHost.replaceChildren(h("p", { class: "discret" }, "Sélectionnez une version à gauche pour la parcourir."));
    restoreButton.disabled = true;
    versionsDialog.showModal();
    void loadVersions();
  };

  mount(
    root,
    h(
      "header",
      { class: "barre" },
      h("a", { href: "/", class: "retour", onclick: (e: Event) => (e.preventDefault(), navigate("/")) }, "← Mes documents"),
      titleInput,
      h("div", { class: "etats" }, status, credit),
      userMenu(me, navigate),
    ),
    banner,
    h(
      "div",
      { class: "espace" },
      toolsAside,
      h("main", { class: "page" }, editorHost),
      h(
        "aside",
        { class: "panneau carte" },
        h("h2", {}, "Présents"),
        presence,
        h("h2", {}, "Lien de téléchargement"),
        linkPanel,
        h("h2", {}, "Versions"),
        h("button", { type: "button", class: "secondaire large", onclick: openVersions }, "Parcourir les versions…"),
        h("h2", {}, "Éditeurs"),
        editors,
        shareForm,
        message,
      ),
    ),
    versionsDialog,
  );

  void loadInfo();
  void loadLinks();
  linkTimer = setInterval(() => document.visibilityState === "visible" && void loadLinks(), LINK_REFRESH_MS);
  refreshCredit();
  connect(false);

  return () => {
    clearTimeout(timer);
    clearTimeout(creditTimer);
    clearInterval(linkTimer);
    disconnect();
  };
}
