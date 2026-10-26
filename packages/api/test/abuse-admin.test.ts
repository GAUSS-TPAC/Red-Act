// Anti-abus visiteurs, tableau de bord admin, actions programmées (étape 6).
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, TABLES } from "@editeur/shared";
import { VISITOR_BLOCK_MS, VisitorGuard, viewerIp } from "../src/abuse.ts";
import { createDocumentClient } from "../src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../../scripts/local-tables.ts";
import { createLocalApi, TEST_SECRET } from "../../../tests/helpers/local-api.ts";

const dbUp = await isLocalDbUp();
const db = createDocumentClient(LOCAL_ENDPOINT);

describe("viewerIp", () => {
  it("retire le port, en IPv4 comme en IPv6", () => {
    expect(viewerIp("198.51.100.7:46532")).toBe("198.51.100.7");
    expect(viewerIp("2001:db8::1:46532")).toBe("2001:db8::1");
    expect(viewerIp(undefined)).toBeUndefined();
  });
});

describe.skipIf(!dbUp)("anti-abus visiteurs (DynamoDB Local)", () => {
  beforeAll(() => ensureLocalTables());

  it("seuil 30/N par 10 s, blocage de 10 min écrit en base et partagé", async () => {
    let clock = Date.parse("2026-11-01T10:00:00Z");
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const guard = new VisitorGuard({ db, now: () => clock, countInstances: async () => 2 });
    await guard.sync();
    expect(guard.limit).toBe(15);

    for (let i = 0; i < 15; i++) expect(guard.hit(ip)).toBeUndefined();
    expect(guard.hit(ip)).toBe(clock + VISITOR_BLOCK_MS); // 16e requête en 10 s
    expect(guard.hit("198.51.100.1")).toBeUndefined(); // les autres passent

    // Une autre instance apprend le blocage à sa synchronisation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const other = new VisitorGuard({ db, now: () => clock });
    await other.sync();
    expect(other.hit(ip)).toBe(clock + VISITOR_BLOCK_MS);

    clock += VISITOR_BLOCK_MS + 1;
    expect(guard.hit(ip)).toBeUndefined();
  });

  it("exempte l'adresse de l'instance de test de charge", async () => {
    const guard = new VisitorGuard({ db, exemptIps: async () => ["198.18.0.1"] });
    await guard.sync();
    for (let i = 0; i < 1_000; i++) expect(guard.hit("198.18.0.1")).toBeUndefined();
  });

  it("le clic répond 429 + Retry-After à une adresse bloquée, sans toucher au lien", async () => {
    const guard = new VisitorGuard({ db });
    const { app } = createLocalApi(undefined, { visitorGuard: guard });
    const headers = { "cloudfront-viewer-address": `192.0.2.${Math.floor(Math.random() * 250)}:1234` };
    const url = "/api/links/00000000-0000-4000-8000-000000000000/claim";
    for (let i = 0; i < 30; i++) expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(404);
    const blocked = await app.inject({ method: "POST", url, headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["cache-control"]).toBe("no-store");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(500);
    expect(blocked.json()).toMatchObject({ etat: "bloque" });
    await app.close();
  });
});

describe.skipIf(!dbUp)("tableau de bord et actions programmées (DynamoDB Local)", () => {
  const scheduled: { linkId: string; opensAt: number }[] = [];
  const unscheduled: string[] = [];
  const { app } = createLocalApi(undefined, {
    adminToken: "jeton-admin-de-test",
    scheduleScaling: async (linkId, opensAt) => void scheduled.push({ linkId, opensAt }),
    unscheduleScaling: async (linkId) => void unscheduled.push(linkId),
  });
  const auth = { authorization: `Bearer ${createSessionToken({ email: "admin-test@test.local", name: "A" }, TEST_SECRET)}` };
  const admin = { "x-admin-token": "jeton-admin-de-test" };
  beforeAll(() => ensureLocalTables());
  afterAll(() => app.close());

  it("refuse sans jeton ou avec un mauvais jeton", async () => {
    for (const headers of [{}, { "x-admin-token": "faux" }]) {
      const response = await app.inject({ method: "GET", url: "/api/admin/blocages", headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it("liens actifs avec restants, programmation du pic, blocages en cours, documents ouverts", async () => {
    const docId = (await app.inject({ method: "POST", url: "/api/documents", headers: auth, payload: { title: "Admin" } })).json().docId;
    const opensAt = "2026-12-01T18:00:00.000Z";
    const link = (
      await app.inject({ method: "POST", url: `/api/documents/${docId}/links`, headers: auth, payload: { max: 7, opensAt } })
    ).json();
    expect(scheduled).toContainEqual({ linkId: link.linkId, opensAt: Date.parse(opensAt) });

    const liens = (await app.inject({ method: "GET", url: "/api/admin/liens-actifs", headers: admin })).json().liens;
    expect(liens).toContainEqual(expect.objectContaining({ linkId: link.linkId, max: 7, remaining: 7, opensAt }));

    const now = Date.now();
    await db.send(new PutCommand({ TableName: TABLES.blocks.tableName, Item: { subject: "writer#actif@test.local", reason: "test", expireLe: now + 60_000, ttl: 0 } }));
    await db.send(new PutCommand({ TableName: TABLES.blocks.tableName, Item: { subject: "writer#expire@test.local", reason: "test", expireLe: now - 1, ttl: 0 } }));
    const blocages = (await app.inject({ method: "GET", url: "/api/admin/blocages", headers: admin })).json().blocages;
    const subjects = blocages.map((b: { subject: string }) => b.subject);
    expect(subjects).toContain("writer#actif@test.local");
    expect(subjects).not.toContain("writer#expire@test.local"); // TTL en retard : filtré

    await db.send(new PutCommand({ TableName: TABLES.presence.tableName, Item: { docId, title: "Admin", connected: 3, lastBeat: now, ttl: 0 } }));
    const ouverts = (await app.inject({ method: "GET", url: "/api/admin/documents-ouverts", headers: admin })).json().documents;
    expect(ouverts).toContainEqual(expect.objectContaining({ docId, title: "Admin", connected: 3 }));
  });

  it("fermer un lien à heure d'ouverture retire ses actions programmées (une seule fois)", async () => {
    const docId = (await app.inject({ method: "POST", url: "/api/documents", headers: auth, payload: { title: "Pic annulé" } })).json().docId;
    const create = (payload: object) => app.inject({ method: "POST", url: `/api/documents/${docId}/links`, headers: auth, payload });
    const close = (linkId: string) => app.inject({ method: "POST", url: `/api/links/${linkId}/close`, headers: auth });

    const timed = (await create({ max: 3, opensAt: new Date(Date.now() + 3_600_000).toISOString() })).json();
    await close(timed.linkId);
    await close(timed.linkId); // déjà fermé : rien de plus
    expect(unscheduled.filter((id) => id === timed.linkId)).toHaveLength(1);

    const plain = (await create({ max: 3 })).json(); // sans heure d'ouverture : pas d'action
    await close(plain.linkId);
    expect(unscheduled).not.toContain(plain.linkId);
  });
});
