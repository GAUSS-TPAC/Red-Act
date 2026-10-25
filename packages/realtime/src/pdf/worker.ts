/**
 * Worker thread de rendu PDF (bundle séparé `pdf-worker.cjs`) et son pilote côté
 * serveur. Un seul worker, réutilisé : les rendus sont rares (une génération sert
 * toutes les demandes antérieures d'un document) et courts.
 */
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { renderPdf, type RenderInput } from "./render.ts";

interface Job {
  id: number;
  input: RenderInput;
}

type Reply = { id: number; pdf: Uint8Array } | { id: number; error: string };

// Côté worker : un message = un rendu.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (job: Job) => {
    renderPdf(job.input).then(
      (pdf) => port.postMessage({ id: job.id, pdf } satisfies Reply, [pdf.buffer as ArrayBuffer]),
      (error: unknown) => port.postMessage({ id: job.id, error: String(error) } satisfies Reply),
    );
  });
}

/** Rendu dans le worker `file` ; le worker est relancé s'il s'arrête. */
export function workerRenderer(file: string): (input: RenderInput) => Promise<Uint8Array> {
  let worker: Worker | undefined;
  let nextId = 0;
  const waiting = new Map<number, { resolve: (pdf: Uint8Array) => void; reject: (error: Error) => void }>();

  const start = () => {
    const w = new Worker(file);
    w.on("message", (reply: Reply) => {
      const job = waiting.get(reply.id);
      waiting.delete(reply.id);
      if ("error" in reply) job?.reject(new Error(reply.error));
      else job?.resolve(reply.pdf);
    });
    w.on("error", (error) => {
      for (const job of waiting.values()) job.reject(error);
      waiting.clear();
    });
    w.on("exit", () => (worker = undefined));
    w.unref();
    return w;
  };

  return (input) =>
    new Promise((resolve, reject) => {
      worker ??= start();
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, input } satisfies Job);
    });
}
