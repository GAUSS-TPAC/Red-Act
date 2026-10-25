/**
 * Lecture de la file `pdf-requests` (long polling) : les demandes d'un même
 * document sont fusionnées (on garde le plus grand `seqRequis`), et un message
 * n'est supprimé qu'une fois le PDF prêt. Si la génération échoue, le message
 * réapparaît après le délai de visibilité de la file et sera retenté.
 */
import type { PdfRequest } from "@editeur/shared";
import type { PdfGenerator } from "./generator.ts";

export interface PdfQueue {
  /** Attend au plus ~20 s (long polling) ; renvoie 0 à 10 messages. */
  receive(): Promise<{ handle: string; request: PdfRequest }[]>;
  remove(handles: string[]): Promise<void>;
}

export async function consumePdfRequests(
  queue: PdfQueue,
  generator: PdfGenerator,
  options: { signal?: AbortSignal; log?: { error: (obj: unknown, msg: string) => void } } = {},
): Promise<void> {
  while (!options.signal?.aborted) {
    let messages: Awaited<ReturnType<PdfQueue["receive"]>>;
    try {
      messages = await queue.receive();
    } catch (error) {
      options.log?.error({ error }, "lecture de la file pdf-requests impossible");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }

    const byDoc = new Map<string, { seqRequis: number; handles: string[] }>();
    for (const { handle, request } of messages) {
      const entry = byDoc.get(request.docId) ?? { seqRequis: -1, handles: [] };
      entry.seqRequis = Math.max(entry.seqRequis, request.seqRequis);
      entry.handles.push(handle);
      byDoc.set(request.docId, entry);
    }
    // Pas d'attente : le générateur sérialise par document, la lecture continue.
    for (const [docId, { seqRequis, handles }] of byDoc) {
      generator
        .request(docId, seqRequis)
        .then(() => queue.remove(handles))
        .catch((error: unknown) => options.log?.error({ error, docId }, "génération du PDF impossible"));
    }
  }
}
