import { SSM_PARAMS } from "@editeur/shared";
import { buildApp } from "./app.ts";
import { createDocumentClient, createPresigner, readSecureParameter } from "./aws.ts";
import { ClaimService } from "./links/claim.ts";

const port = Number(process.env.PORT ?? 3000);

async function main() {
  // HMAC_SECRET n'est utilisé qu'en local ; sur AWS le secret vient de SSM (SecureString).
  const hmacSecret = process.env.HMAC_SECRET ?? (await readSecureParameter(SSM_PARAMS.hmacSecret));
  const bucket = process.env.BUCKET ?? "editeur-local";

  const db = createDocumentClient();
  const app = buildApp(
    { logger: true, trustProxy: false },
    {
      db,
      hmacSecret,
      claims: new ClaimService({
        db,
        hmacSecret,
        presign: createPresigner(bucket),
        // Étape 4 : file SQS pdf-requests. Étape 6 : e-mail SES au créateur.
        requestPdf: async (docId, seqRequis) => app.log.info({ docId, seqRequis }, "PDF demandé"),
        onLastCopy: async (link) => app.log.info({ linkId: link.linkId }, "dernier exemplaire réservé"),
        log: { error: (obj, msg) => app.log.error(obj, msg) },
      }),
    },
  );

  await app.listen({ host: "0.0.0.0", port });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
