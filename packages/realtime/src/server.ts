// Point d'entrée du serveur temps réel (une seule instance, CLAUDE.md §4).
import * as path from "node:path";
import { SSM_PARAMS } from "@editeur/shared";
import { createDocumentClient, readSecureParameter, s3BlobStore, sqsPdfQueue } from "./aws.ts";
import { consumePdfRequests } from "./pdf/consumer.ts";
import { PdfGenerator } from "./pdf/generator.ts";
import { workerRenderer } from "./pdf/worker.ts";
import { compactPending, createRealtimeServer } from "./realtime.ts";
import { memoryBlobStore } from "./store.ts";

const log = {
  info: (obj: unknown, msg: string) => console.log(JSON.stringify({ niveau: "info", msg, ...toFields(obj) })),
  error: (obj: unknown, msg: string) => console.error(JSON.stringify({ niveau: "erreur", msg, ...toFields(obj) })),
};

function toFields(obj: unknown) {
  if (!obj || typeof obj !== "object") return {};
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, v instanceof Error ? { name: v.name, message: v.message } : v]),
  );
}

async function main() {
  // HMAC_SECRET et la mémoire ne servent qu'en local ; sur AWS : SSM et S3.
  const hmacSecret = process.env.HMAC_SECRET ?? (await readSecureParameter(SSM_PARAMS.hmacSecret));
  const blobs = process.env.BUCKET ? s3BlobStore(process.env.BUCKET) : memoryBlobStore();
  const db = createDocumentClient();

  const { server, openState } = createRealtimeServer({
    db,
    blobs,
    hmacSecret,
    port: Number(process.env.PORT ?? 1234),
    log,
    // Étape 6 : blocage après 5 refus en 1 min.
    onRefusal: (writer, code) => log.info({ writer, code }, "modification refusée"),
  });
  await server.listen();
  log.info({ port: server.address.port }, "serveur temps réel démarré");

  // Génération des PDF (C3) : demandes lues dans la file SQS pdf-requests, rendu
  // dans un worker thread (bundle pdf-worker.cjs à côté de server.cjs).
  const generator = new PdfGenerator({
    db,
    blobs,
    render: workerRenderer(path.join(__dirname, "pdf-worker.cjs")),
    openState,
    log,
  });
  if (process.env.QUEUE_URL) void consumePdfRequests(sqsPdfQueue(process.env.QUEUE_URL), generator, { log });
  else log.info({}, "QUEUE_URL absent : pas de génération de PDF");

  // Reprise après un arrêt brutal : compacter ce qui ne l'a pas été.
  void compactPending({ db, blobs, log }).catch((error: unknown) => log.error({ error }, "reprise des compactions"));

  // Arrêt propre (mise à jour de l'ASG) : chaque document est vidé puis compacté.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void server.destroy().then(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
