import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TEXT_NAME } from "@editeur/shared";
import { analyzeUpdate } from "../src/content.ts";

const updateOf = (doc: Y.Doc, change: () => void) => {
  let captured: Uint8Array | undefined;
  const handler = (u: Uint8Array) => (captured = u);
  doc.on("update", handler);
  change();
  doc.off("update", handler);
  return captured!;
};

describe("analyzeUpdate", () => {
  it("compte les caractères insérés, pas les suppressions", () => {
    const client = new Y.Doc();
    const server = new Y.Doc();
    const text = client.getText(TEXT_NAME);
    const insert = updateOf(client, () => text.insert(0, "Bonjour 👋"));
    expect(analyzeUpdate(insert, Y.encodeStateVector(server))).toEqual({ valid: true, chars: 10, empty: false });
    Y.applyUpdate(server, insert);

    const del = updateOf(client, () => text.delete(0, 3));
    expect(analyzeUpdate(del, Y.encodeStateVector(server))).toEqual({ valid: true, chars: 0, empty: false });
  });

  it("ne recompte pas un contenu que le serveur a déjà (resynchronisation)", () => {
    const client = new Y.Doc();
    const server = new Y.Doc();
    client.getText(TEXT_NAME).insert(0, "déjà connu");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
    client.getText(TEXT_NAME).insert(0, "neuf ");
    const all = Y.encodeStateAsUpdate(client);
    expect(analyzeUpdate(all, Y.encodeStateVector(server))).toMatchObject({ valid: true, chars: 5 });
  });

  it("un client neuf n'apporte rien", () => {
    const server = new Y.Doc();
    server.getText(TEXT_NAME).insert(0, "texte");
    const fresh = Y.encodeStateAsUpdate(new Y.Doc(), Y.encodeStateVector(server));
    expect(analyzeUpdate(fresh, Y.encodeStateVector(server))).toEqual({ valid: true, chars: 0, empty: true });
  });

  it("refuse un contenu qui n'est pas du texte", () => {
    const client = new Y.Doc();
    const update = updateOf(client, () => client.getMap("autre").set("k", "x".repeat(50_000)));
    expect(analyzeUpdate(update, Y.encodeStateVector(new Y.Doc()))).toEqual({ valid: false });
  });

  it("mise en forme admise (FORMATS) : aucun caractère débité", () => {
    const client = new Y.Doc();
    const server = new Y.Doc();
    const text = client.getText(TEXT_NAME);
    const insert = updateOf(client, () => text.insert(0, "Titre", { bold: true, size: "huge", font: "serif" }));
    expect(analyzeUpdate(insert, Y.encodeStateVector(server))).toEqual({ valid: true, chars: 5, empty: false });
    Y.applyUpdate(server, insert);
    const format = updateOf(client, () => text.format(0, 5, { italic: true, underline: true, bold: null, font: "monospace" }));
    expect(analyzeUpdate(format, Y.encodeStateVector(server))).toEqual({ valid: true, chars: 0, empty: false });
  });

  it("refuse un format inconnu ou une valeur hors liste (contournement du PDF ou du crédit)", () => {
    for (const attributes of [{ color: "red" }, { size: "999px" }, { font: "Comic Sans" }, { bold: "oui" }, { link: "javascript:alert(1)" }]) {
      const client = new Y.Doc();
      const update = updateOf(client, () => client.getText(TEXT_NAME).insert(0, "x", attributes));
      expect(analyzeUpdate(update, Y.encodeStateVector(new Y.Doc())), JSON.stringify(attributes)).toEqual({ valid: false });
    }
  });

  it("refuse un objet inséré dans le texte (image, embed)", () => {
    const client = new Y.Doc();
    const update = updateOf(client, () => client.getText(TEXT_NAME).insertEmbed(0, { image: "x" }));
    expect(analyzeUpdate(update, Y.encodeStateVector(new Y.Doc()))).toEqual({ valid: false });
  });
});
