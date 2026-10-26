// Éléments communs aux pages des rédacteurs : identité et déconnexion.
import { h } from "../dom.ts";
import { clearSession, type Session } from "../session.ts";

/** Nom du rédacteur et bouton « Se déconnecter » (oublie l'identité de ce navigateur). */
export function userMenu(me: Session, navigate: (path: string) => void) {
  return h(
    "div",
    { class: "utilisateur" },
    h("span", { class: "avatar", title: me.email }, me.name.slice(0, 1).toUpperCase()),
    h("span", { class: "nom" }, me.name),
    h(
      "button",
      {
        class: "secondaire",
        type: "button",
        onclick: () => {
          clearSession();
          navigate("/");
        },
      },
      "Se déconnecter",
    ),
  );
}
