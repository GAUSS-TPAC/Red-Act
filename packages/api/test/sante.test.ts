import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

const app = buildApp();
afterAll(() => app.close());

describe("GET /sante", () => {
  it("répond 200 sans mise en cache", async () => {
    const response = await app.inject({ method: "GET", url: "/sante" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ statut: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("répond 404 sur une route inconnue", async () => {
    const response = await app.inject({ method: "GET", url: "/inconnue" });
    expect(response.statusCode).toBe(404);
  });
});
