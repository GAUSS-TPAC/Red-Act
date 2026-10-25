// C1 en local : ≥ 1 000 clics simultanés répartis sur 3 instances API, plusieurs tirages.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocumentClient } from "../../packages/api/src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";
import { createLocalApi, type LocalApi } from "../helpers/local-api.ts";
import { runC1 } from "./scenario.ts";
import { dbState } from "./verify-db.ts";

const dbUp = await isLocalDbUp();
const REQUESTS = 1_200;

describe.skipIf(!dbUp)("C1 — jamais un téléchargement de plus (DynamoDB Local)", () => {
  const instances: LocalApi[] = [];
  const baseUrls: string[] = [];
  const db = createDocumentClient(LOCAL_ENDPOINT);

  beforeAll(async () => {
    await ensureLocalTables();
    for (let i = 0; i < 3; i++) {
      const api = createLocalApi();
      await api.app.listen({ host: "127.0.0.1", port: 0 });
      instances.push(api);
      baseUrls.push(`http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`);
    }
  });

  afterAll(async () => {
    await Promise.all(instances.map((i) => i.app.close()));
  });

  it.each([1, 50, 500])(`%i exemplaires, ${REQUESTS} clics simultanés`, async (copies) => {
    const result = await runC1({ baseUrls, copies, requests: REQUESTS, target: "local" });
    const state = await dbState(db, result.linkId);

    expect(result.networkErrors).toBe(0);
    // Exactement K réservations vues par les visiteurs, le reste en 410.
    expect(result.reserved).toBe(copies);
    expect((result.statuses["200"] ?? 0) + (result.statuses["202"] ?? 0)).toBe(copies);
    expect(result.statuses["410"]).toBe(REQUESTS - copies);
    // Et en base : stock à 0, K réservations, lien sorti de l'index des actifs.
    expect(state).toEqual({ remaining: 0, status: "epuise", activeFlag: null, reservations: copies });
    // Second clic avec ticket : jamais 410, jamais de nouvelle réservation.
    expect(result.replay.statuses["410"]).toBeUndefined();
    expect(result.replay.newTicket).toBe(0);
    // Le créateur n'est prévenu qu'une fois, par une seule instance.
    expect(instances.flatMap((i) => i.lastCopies).filter((l) => l.linkId === result.linkId)).toHaveLength(1);
  });
});
