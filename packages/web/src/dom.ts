// Création d'éléments DOM sans framework : h("button", { class: "x", onclick }, "Texte").

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key in el && key !== "list") {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  el.append(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (typeof c === "number" ? String(c) : c)));
  return el;
}

/** Remplace le contenu d'un élément. */
export function mount(parent: Element, ...children: Child[]) {
  parent.replaceChildren(...children.filter((c): c is Node | string => typeof c === "string" || c instanceof Node));
}

export const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

/** Couleur stable dérivée d'un texte (curseurs et présence). */
export function colorFor(text: string): { color: string; light: string } {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return { color: `hsl(${hue} 65% 42%)`, light: `hsl(${hue} 65% 42% / 0.2)` };
}
