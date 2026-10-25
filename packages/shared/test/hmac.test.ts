import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  createTicket,
  safeEqual,
  SESSION_TTL_SECONDS,
  TICKET_TTL_SECONDS,
  verifySessionToken,
  verifyTicket,
} from "../src/index.ts";

const SECRET = "s".repeat(32);
const NOW = 1_800_000_000;
const session = { email: "alan@example.org", name: "Alan" };
const ticket = { linkId: "lien-1", reservationId: "resa-1" };

describe("jetons de session", () => {
  it("vérifie un jeton valide et rend ses champs", () => {
    const token = createSessionToken(session, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW + 10)).toEqual({
      ok: true,
      claims: { ...session, exp: NOW + SESSION_TTL_SECONDS },
    });
  });

  it("refuse un jeton expiré (24 h)", () => {
    const token = createSessionToken(session, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW + SESSION_TTL_SECONDS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuse une charge utile modifiée", () => {
    const [, signature] = createSessionToken(session, SECRET, NOW).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...session, email: "autre@example.org", k: "session", exp: NOW + 999 }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuse un jeton signé avec un autre secret", () => {
    const token = createSessionToken(session, "x".repeat(32), NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toMatchObject({ ok: false, reason: "signature" });
  });

  it.each(["", "abc", "a.b.c", ".", "a."])("refuse le format invalide %j", (token) => {
    expect(verifySessionToken(token, SECRET, NOW)).toMatchObject({ ok: false });
  });

  it("refuse un secret trop court", () => {
    expect(() => createSessionToken(session, "court", NOW)).toThrow(/32 octets/);
  });
});

describe("tickets", () => {
  it("vérifie un ticket valide pendant 2 min, puis le refuse", () => {
    const token = createTicket(ticket, SECRET, NOW);
    expect(verifyTicket(token, SECRET, NOW + TICKET_TTL_SECONDS - 1)).toMatchObject({
      ok: true,
      claims: ticket,
    });
    expect(verifyTicket(token, SECRET, NOW + TICKET_TTL_SECONDS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("n'accepte pas un ticket comme jeton de session, ni l'inverse", () => {
    expect(verifySessionToken(createTicket(ticket, SECRET, NOW), SECRET, NOW)).toEqual({
      ok: false,
      reason: "kind",
    });
    expect(verifyTicket(createSessionToken(session, SECRET, NOW), SECRET, NOW)).toEqual({
      ok: false,
      reason: "kind",
    });
  });
});

describe("safeEqual", () => {
  it("compare des chaînes de longueurs quelconques", () => {
    expect(safeEqual("jeton-admin", "jeton-admin")).toBe(true);
    expect(safeEqual("jeton-admin", "jeton-admiN")).toBe(false);
    expect(safeEqual("court", "beaucoup-plus-long")).toBe(false);
  });
});
