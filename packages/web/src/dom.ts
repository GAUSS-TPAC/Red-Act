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

// Teintes nettement distinctes, assez foncées pour un nom en blanc : deux teintes HSL
// voisines (ancien calcul, 304° et 298° pour deux adresses proches) se confondaient.
const HUES = [4, 28, 48, 96, 150, 180, 205, 230, 270, 320];

/** Couleur stable dérivée d'un texte (curseurs et présence). */
export function colorFor(text: string): { color: string; light: string } {
  let hash = 0x811c9dc5; // FNV-1a : mieux réparti que *31 sur des adresses voisines
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  const hue = HUES[(hash >>> 0) % HUES.length]!;
  return { color: `hsl(${hue} 70% 38%)`, light: `hsl(${hue} 70% 38% / 0.2)` };
}
