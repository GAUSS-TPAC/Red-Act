// Point d'entrée du serveur temps réel (une seule instance, CLAUDE.md §4).
import { SSM_PARAMS } from "@editeur/shared";
import { createDocumentClient, readSecureParameter, s3BlobStore } from "./aws.ts";
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

  const { server } = createRealtimeServer({
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
