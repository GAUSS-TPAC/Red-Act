import { describe, expect, it } from "vitest";
import type { PdfRequest } from "@editeur/shared";
import { dampedPdfRequester, RESEND_AFTER_MS } from "../src/pdf-requests.ts";

describe("dampedPdfRequester", () => {
  it("n'envoie qu'une demande par document pendant un pic, sauf séquence plus récente ou délai écoulé", async () => {
    let clock = 0;
    const sent: PdfRequest[] = [];
    const request = dampedPdfRequester(async (r) => void sent.push(r), () => clock);

    for (let i = 0; i < 1_000; i++) await request("doc", 4); // 1 000 clics « 202 »
    expect(sent).toEqual([{ docId: "doc", seqRequis: 4 }]);

    await request("doc", 3); // déjà couvert
    await request("doc", 6); // plus récente : envoyée
    await request("autre", 1); // autre document
    expect(sent).toHaveLength(3);

    clock += RESEND_AFTER_MS; // demande peut-être perdue : on la renvoie
    await request("doc", 6);
    expect(sent.at(-1)).toEqual({ docId: "doc", seqRequis: 6 });
    expect(sent).toHaveLength(4);
  });
});
