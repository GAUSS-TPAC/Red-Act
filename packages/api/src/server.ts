import * as path from "node:path";
import { SSM_PARAMS } from "@editeur/shared";
import { buildApp } from "./app.ts";
import { createDocumentClient, createPresigner, readSecureParameter } from "./aws.ts";
import { ClaimService } from "./links/claim.ts";
import { dampedPdfRequester, sqsSender } from "./pdf-requests.ts";

const port = Number(process.env.PORT ?? 3000);

async function main() {
  // HMAC_SECRET n'est utilisé qu'en local ; sur AWS le secret vient de SSM (SecureString).
  const hmacSecret = process.env.HMAC_SECRET ?? (await readSecureParameter(SSM_PARAMS.hmacSecret));
  const bucket = process.env.BUCKET ?? "editeur-local";

  const db = createDocumentClient();
  // File SQS pdf-requests (C3) ; sans QUEUE_URL (local), la demande est seulement journalisée.
  const queueUrl = process.env.QUEUE_URL;
  const requestPdf = dampedPdfRequester(
    queueUrl ? sqsSender(queueUrl) : async (request) => console.log(JSON.stringify({ msg: "PDF demandé", ...request })),
  );
  const app = buildApp(
    { logger: true, trustProxy: false },
    {
      db,
      hmacSecret,
      requestPdf,
      claims: new ClaimService({
        db,
        hmacSecret,
        presign: createPresigner(bucket),
        requestPdf,
        // Étape 6 : e-mail SES au créateur.
        onLastCopy: async (link) => app.log.info({ linkId: link.linkId }, "dernier exemplaire réservé"),
        log: { error: (obj, msg) => app.log.error(obj, msg) },
      }),
    },
    // Front construit par `npm run build` à côté du bundle (dist/public).
    path.join(__dirname, "public"),
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
