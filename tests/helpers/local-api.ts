// Instances API branchées sur DynamoDB Local, pour les tests d'intégration et C1.
import type { LinkItem } from "@editeur/shared";
import { buildApp } from "../../packages/api/src/app.ts";
import { createDocumentClient } from "../../packages/api/src/aws.ts";
import { ClaimService } from "../../packages/api/src/links/claim.ts";
import { LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";

export const TEST_SECRET = "secret-de-test-local-32-octets-min!";

export interface LocalApi {
  app: ReturnType<typeof buildApp>;
  pdfRequests: { docId: string; seqRequis: number }[];
  lastCopies: LinkItem[];
}

/**
 * Une instance = une mémoire « épuisé » propre, comme une instance EC2.
 * `requestPdf` : branchement direct sur un générateur (tests C3), à la place de la file SQS.
 */
export function createLocalApi(
  now?: () => number,
  options: { requestPdf?: (docId: string, seqRequis: number) => Promise<void> } = {},
): LocalApi {
  const db = createDocumentClient(LOCAL_ENDPOINT);
  const pdfRequests: LocalApi["pdfRequests"] = [];
  const lastCopies: LinkItem[] = [];
  const claims = new ClaimService({
    db,
    hmacSecret: TEST_SECRET,
    presign: async (key) => `https://s3.local/${key}?signature=${Math.random().toString(36).slice(2)}`,
    requestPdf: async (docId, seqRequis) => {
      pdfRequests.push({ docId, seqRequis });
      await options.requestPdf?.(docId, seqRequis);
    },
    onLastCopy: async (link) => {
      lastCopies.push(link);
    },
    log: { error: () => {} },
    now,
  });
  const app = buildApp({}, { db, hmacSecret: TEST_SECRET, claims, now, requestPdf: options.requestPdf });
  return { app, pdfRequests, lastCopies };
}
