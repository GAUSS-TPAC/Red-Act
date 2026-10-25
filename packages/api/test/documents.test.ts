// Routes de lecture du front et service des fichiers statiques.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "@editeur/shared";
import { buildApp } from "../src/app.ts";
import { ensureLocalTables, isLocalDbUp } from "../../../scripts/local-tables.ts";
import { createLocalApi, TEST_SECRET } from "../../../tests/helpers/local-api.ts";

describe("fichiers statiques", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "public-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(path.join(dir, "assets", "main-ABC.js"), "console.log(1)");
  const app = buildApp({}, undefined, dir);
  afterAll(() => app.close());

  it("sert les pages du front (index.html, jamais en cache) et les assets (en cache)", async () => {
    for (const url of ["/", "/doc/0b6d0000-0000-4000-8000-000000000000", "/l/0b6d0000-0000-4000-8000-000000000000"]) {
      const page = await app.inject({ method: "GET", url });
      expect(page.statusCode).toBe(200);
      expect(page.headers["cache-control"]).toBe("no-cache");
      expect(page.body).toContain("<!doctype html>");
    }
    const asset = await app.inject({ method: "GET", url: "/assets/main-ABC.js" });
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("ne sort pas du dossier et répond 404 JSON sous /api", async () => {
    expect((await app.inject({ method: "GET", url: "/assets/..%2Findex.html" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/assets/absent.js" })).statusCode).toBe(404);
    const api = await app.inject({ method: "GET", url: "/api/inconnu" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ erreur: "introuvable" });
  });
});

const dbUp = await isLocalDbUp();

describe.skipIf(!dbUp)("lecture des documents (DynamoDB Local)", () => {
  const { app } = createLocalApi();
  const auth = (email: string) => ({ authorization: `Bearer ${createSessionToken({ email, name: "T" }, TEST_SECRET)}` });
  beforeAll(() => ensureLocalTables());
  afterAll(() => app.close());

  it("liste les documents dont on est éditeur, détail, versions, crédit", async () => {
    const owner = `liste-${Date.now()}@test.local`;
    const created = (await app.inject({ method: "POST", url: "/api/documents", headers: auth(owner), payload: { title: "Zèbre" } })).json();
    await app.inject({ method: "POST", url: "/api/documents", headers: auth(owner), payload: { title: "Abeille" } });

    const list = (await app.inject({ method: "GET", url: "/api/documents", headers: auth(owner) })).json();
    expect(list.documents.map((d: { title: string }) => d.title)).toEqual(["Abeille", "Zèbre"]);
    expect((await app.inject({ method: "GET", url: "/api/documents", headers: auth("personne@test.local") })).json().documents).not.toContainEqual(
      expect.objectContaining({ docId: created.docId }),
    );

    const detail = await app.inject({ method: "GET", url: `/api/documents/${created.docId}`, headers: auth(owner) });
    expect(detail.json()).toMatchObject({ title: "Zèbre", ownerEmail: owner, editors: [owner], seq: 0 });
    expect((await app.inject({ method: "GET", url: `/api/documents/${created.docId}`, headers: auth("intrus@test.local") })).statusCode).toBe(403);

    const versions = await app.inject({ method: "GET", url: `/api/documents/${created.docId}/versions`, headers: auth(owner) });
    expect(versions.json()).toEqual({ versions: [] });

    const credit = await app.inject({ method: "GET", url: "/api/me/credit", headers: auth(owner) });
    expect(credit.json()).toEqual({ used: 0, remaining: 10_000, limit: 10_000 });
    expect((await app.inject({ method: "GET", url: "/api/me/credit" })).statusCode).toBe(401);
  });
});
