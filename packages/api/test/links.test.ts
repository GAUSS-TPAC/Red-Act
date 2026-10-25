// Routes session / documents / liens / clic, contre DynamoDB Local.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TABLES } from "@editeur/shared";
import { createDocumentClient } from "../src/aws.ts";
import { readCookie } from "../src/routes.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../../scripts/local-tables.ts";
import { createLocalApi } from "../../../tests/helpers/local-api.ts";
import { dbState } from "../../../tests/c1/verify-db.ts";

const dbUp = await isLocalDbUp();

describe("readCookie", () => {
  it("lit un cookie parmi d'autres, valeur contenant des '='", () => {
    expect(readCookie("a=1; ticket=x.y==; b=2", "ticket")).toBe("x.y==");
    expect(readCookie(undefined, "ticket")).toBeUndefined();
  });
});

describe.skipIf(!dbUp)("liens et clics (DynamoDB Local)", () => {
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const api = createLocalApi(() => clock);
  const other = createLocalApi(() => clock); // seconde instance, mémoire séparée
  const db = createDocumentClient(LOCAL_ENDPOINT);
  const { app } = api;

  const session = async (email: string) =>
    (await app.inject({ method: "POST", url: "/api/session", payload: { name: "Test", email } })).json()
      .token as string;

  const setup = async (max: number, opensAt?: string) => {
    const token = await session("Auteur@Test.local ");
    const auth = { authorization: `Bearer ${token}` };
    const doc = (await app.inject({ method: "POST", url: "/api/documents", headers: auth, payload: { title: "T" } }))
      .json();
    const link = await app.inject({
      method: "POST",
      url: `/api/documents/${doc.docId}/links`,
      headers: auth,
      payload: { max, ...(opensAt ? { opensAt } : {}) },
    });
    expect(link.statusCode).toBe(201);
    return { docId: doc.docId as string, linkId: link.json().linkId as string, auth };
  };

  const claim = (linkId: string, ticket?: string, instance = app) =>
    instance.inject({
      method: "POST",
      url: `/api/links/${linkId}/claim`,
      headers: ticket ? { cookie: `ticket=${ticket}` } : {},
    });

  const ticketOf = (response: { headers: Record<string, unknown> }) =>
    readCookie(String(response.headers["set-cookie"] ?? "").split(";")[0], "ticket");

  const pdfReady = (docId: string, pdfSeq = 0) =>
    db.send(
      new UpdateCommand({
        TableName: TABLES.documents.tableName,
        Key: { docId },
        UpdateExpression: "SET pdfSeq = :p",
        ExpressionAttributeValues: { ":p": pdfSeq },
      }),
    );

  beforeAll(() => ensureLocalTables());
  afterAll(async () => {
    await app.close();
    await other.app.close();
  });

  describe("session et création", () => {
    it("normalise l'e-mail de session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        payload: { name: " Alan ", email: " Alan@Exemple.ORG" },
      });
      expect(response.json()).toMatchObject({ email: "alan@exemple.org", name: "Alan" });
    });

    it("refuse une adresse invalide", async () => {
      const response = await app.inject({ method: "POST", url: "/api/session", payload: { name: "A", email: "abc" } });
      expect(response.statusCode).toBe(400);
    });

    it("exige une session pour créer un document", async () => {
      const response = await app.inject({ method: "POST", url: "/api/documents", payload: { title: "T" } });
      expect(response.statusCode).toBe(401);
    });

    it("refuse la création d'un lien à un non-éditeur", async () => {
      const { docId } = await setup(1);
      const intrus = await session("intrus@test.local");
      const response = await app.inject({
        method: "POST",
        url: `/api/documents/${docId}/links`,
        headers: { authorization: `Bearer ${intrus}` },
        payload: { max: 3 },
      });
      expect(response.statusCode).toBe(403);
    });

    it("partage : un éditeur ajoute un éditeur, un non-éditeur ne peut pas", async () => {
      const { docId, auth } = await setup(1);
      const share = (headers: Record<string, string>, email: string, id = docId) =>
        app.inject({ method: "POST", url: `/api/documents/${id}/editors`, headers, payload: { email } });

      expect((await share(auth, " Invite@Test.local")).json()).toEqual({ docId, email: "invite@test.local" });
      const invite = { authorization: `Bearer ${await session("invite@test.local")}` };
      // L'invité est éditeur : il peut créer un lien et partager à son tour.
      const link = await app.inject({ method: "POST", url: `/api/documents/${docId}/links`, headers: invite, payload: { max: 1 } });
      expect(link.statusCode).toBe(201);
      expect((await share(invite, "troisieme@test.local")).statusCode).toBe(200);

      const intrus = { authorization: `Bearer ${await session("intrus@test.local")}` };
      expect((await share(intrus, "complice@test.local")).statusCode).toBe(403);
      expect((await share(auth, "x@test.local", "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
      expect((await share(auth, "pas-un-email")).statusCode).toBe(400);
    });

    it("refuse un nombre d'exemplaires invalide", async () => {
      const { docId, auth } = await setup(1);
      for (const max of [0, -1, 1.5, 100_001]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/documents/${docId}/links`,
          headers: auth,
          payload: { max },
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe("clic", () => {
    it("404 sur un lien inconnu ou mal formé, sans mise en cache", async () => {
      const unknown = await claim("00000000-0000-4000-8000-000000000000");
      expect(unknown.statusCode).toBe(404);
      expect(unknown.headers["cache-control"]).toBe("no-store");
      expect((await claim("pas-un-id")).statusCode).toBe(404);
    });

    it("202 tant que le PDF n'est pas prêt, demande de génération, ticket réutilisable sans décrément", async () => {
      const { docId, linkId } = await setup(5);
      const first = await claim(linkId);
      expect(first.statusCode).toBe(202);
      expect(first.headers["retry-after"]).toBe("2");
      expect(first.json()).toEqual({ etat: "patienter", retryAfter: 2 });
      expect(api.pdfRequests).toContainEqual({ docId, seqRequis: 0 });
      const ticket = ticketOf(first)!;
      expect(ticket).toBeTruthy();

      const again = await claim(linkId, ticket);
      expect(again.statusCode).toBe(202);
      expect(again.headers["set-cookie"]).toBeUndefined();
      expect((await dbState(db, linkId)).remaining).toBe(4);
    });

    it("200 quand le PDF est prêt ; même URL au second clic, sur une autre instance", async () => {
      const { docId, linkId } = await setup(5);
      await pdfReady(docId);
      const first = await claim(linkId);
      expect(first.statusCode).toBe(200);
      expect(first.json().url).toContain(`pdf/${docId}/0.pdf`);

      const again = await claim(linkId, ticketOf(first), other.app);
      expect(again.statusCode).toBe(200);
      expect(again.json().url).toBe(first.json().url);
      expect(await dbState(db, linkId)).toMatchObject({ remaining: 4, reservations: 1 });
    });

    it("URL expirée, ticket valide : nouvelle URL sur le même PDF, puis stable", async () => {
      const { docId, linkId } = await setup(5);
      await pdfReady(docId);
      const first = await claim(linkId);
      const ticket = ticketOf(first)!;
      clock += 61_000; // URL de 60 s expirée, ticket de 2 min encore valide

      const renewed = await claim(linkId, ticket);
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().url).not.toBe(first.json().url);
      expect(renewed.json().url).toContain(`pdf/${docId}/0.pdf`);
      expect(Date.parse(renewed.json().expiresAt)).toBe(clock + 60_000);

      await pdfReady(docId, 7); // un PDF plus récent ne change pas l'exemplaire réservé
      const again = await claim(linkId, ticket, other.app);
      expect(again.json().url).toBe(renewed.json().url);
      expect(await dbState(db, linkId)).toMatchObject({ remaining: 4, reservations: 1 });
      clock -= 61_000;
    });

    it("deux retours simultanés après expiration : une seule nouvelle URL", async () => {
      const { docId, linkId } = await setup(5);
      await pdfReady(docId);
      const first = await claim(linkId);
      const ticket = ticketOf(first)!;
      clock += 61_000;

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => claim(linkId, ticket, i % 2 ? other.app : app)),
      );
      const urls = new Set(results.map((r) => r.json().url as string));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(urls.size).toBe(1);
      expect(urls.has(first.json().url)).toBe(false);
      clock -= 61_000;
    });

    it("le détenteur du dernier exemplaire est servi même après l'épuisement", async () => {
      const { docId, linkId } = await setup(1);
      const winner = await claim(linkId);
      expect(winner.statusCode).toBe(202);
      expect((await claim(linkId)).statusCode).toBe(410); // l'instance sait le lien épuisé

      await pdfReady(docId);
      const served = await claim(linkId, ticketOf(winner));
      expect(served.statusCode).toBe(200);
      expect(api.lastCopies.filter((l) => l.linkId === linkId)).toHaveLength(1);
      expect(await dbState(db, linkId)).toEqual({
        remaining: 0,
        status: "epuise",
        activeFlag: null,
        reservations: 1,
      });
    });

    it("une autre instance apprend l'épuisement par la base, puis par sa mémoire", async () => {
      const { linkId } = await setup(1);
      await claim(linkId);
      const response = await claim(linkId, undefined, other.app);
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({ etat: "epuise" });
    });

    it("un ticket d'un autre lien ne donne rien et ne protège pas de l'épuisement", async () => {
      const a = await setup(1);
      const b = await setup(1);
      const ticketA = ticketOf(await claim(a.linkId))!;
      await claim(b.linkId);
      expect((await claim(b.linkId, ticketA)).statusCode).toBe(410);
    });

    it("un ticket falsifié est ignoré", async () => {
      const { linkId } = await setup(1);
      const ticket = ticketOf(await claim(linkId))!;
      const forged = `${ticket.split(".")[0]}.AAAA`;
      expect((await claim(linkId, forged)).statusCode).toBe(410);
    });

    it("425 avant l'heure d'ouverture, sans consommer d'exemplaire", async () => {
      const { linkId } = await setup(2, "2026-11-01T10:05:00Z");
      const early = await claim(linkId);
      expect(early.statusCode).toBe(425);
      expect(early.json()).toMatchObject({ etat: "pas-ouvert", opensAt: "2026-11-01T10:05:00.000Z" });
      expect(Number(early.headers["retry-after"])).toBeGreaterThan(0);
      expect((await dbState(db, linkId)).remaining).toBe(2);

      clock = Date.parse("2026-11-01T10:05:00Z");
      expect((await claim(linkId)).statusCode).toBe(202);
      clock = Date.parse("2026-11-01T10:00:00Z");
    });

    it("un ticket expiré (2 min) ne permet plus de revenir", async () => {
      const { linkId } = await setup(1);
      const ticket = ticketOf(await claim(linkId))!;
      clock += 121_000;
      expect((await claim(linkId, ticket)).statusCode).toBe(410);
      clock -= 121_000;
    });
  });
});
