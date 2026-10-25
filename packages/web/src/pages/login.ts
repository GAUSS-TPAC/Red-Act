// Entrée : un nom et une adresse e-mail suffisent (pas de vrais comptes, §8).
import { api, errorText } from "../api.ts";
import { h, mount } from "../dom.ts";
import { setSession } from "../session.ts";

export function loginPage(root: HTMLElement, onDone: () => void) {
  const name = h("input", { name: "name", required: true, maxLength: 80, autocomplete: "name" });
  const email = h("input", { name: "email", type: "email", required: true, maxLength: 254, autocomplete: "email" });
  const error = h("p", { class: "erreur", role: "alert" });

  const form = h(
    "form",
    {
      class: "carte etroite",
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = "";
        try {
          const result = await api<{ token: string; name: string; email: string }>("POST", "/api/session", {
            name: name.value,
            email: email.value,
          });
          setSession(result);
          onDone();
        } catch (e) {
          error.textContent = errorText(e);
        }
      },
    },
    h("h1", {}, "Éditeur du journal"),
    h("p", { class: "discret" }, "Indiquez votre nom et votre adresse e-mail pour écrire."),
    h("label", {}, "Nom", name),
    h("label", {}, "Adresse e-mail", email),
    error,
    h("button", { type: "submit" }, "Entrer"),
  );
  mount(root, form);
  name.focus();
  return () => {};
}
