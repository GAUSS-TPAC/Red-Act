import * as path from "node:path";
import { LOAD_TEST_IP_PARAM, SSM_PARAMS } from "@editeur/shared";
import { buildApp } from "./app.ts";
import { createDocumentClient, createPresigner, readOptionalParameter, readSecureParameter } from "./aws.ts";
import { VisitorGuard } from "./abuse.ts";
import { ClaimService } from "./links/claim.ts";
import { autoScaling, ownAutoScalingGroup, sesNotifier } from "./ops.ts";
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
  const adminToken = process.env.ADMIN_TOKEN ?? (await readSecureParameter(SSM_PARAMS.adminToken));
  // Sur EC2 : ASG de l'instance (seuil anti-abus 30/N, actions programmées).
  const asgName = await ownAutoScalingGroup();
  const asg = asgName ? autoScaling(asgName) : undefined;
  const visitorGuard = new VisitorGuard({
    db,
    countInstances: asg?.countInstances,
    // Instance de test de charge (LoadTestStack) : exemptée tant qu'elle existe.
    exemptIps: asg ? async () => [(await readOptionalParameter(LOAD_TEST_IP_PARAM)) ?? ""].filter(Boolean) : undefined,
    log: { error: (obj, msg) => console.error(JSON.stringify({ msg, ...Object(obj) })) },
  });
  visitorGuard.start();
  // E-mail du dernier exemplaire (SES) ; sans expéditeur configuré, simple journal.
  const notify = process.env.SES_SENDER ? sesNotifier(process.env.SES_SENDER) : undefined;

  const app = buildApp(
    { logger: true, trustProxy: false },
    {
      db,
      hmacSecret,
      requestPdf,
      adminToken,
      visitorGuard,
      scheduleScaling: asg ? (linkId, opensAt) => asg.scheduleForLink(linkId, opensAt) : undefined,
      unscheduleScaling: asg ? (linkId) => asg.unscheduleForLink(linkId) : undefined,
      claims: new ClaimService({
        db,
        hmacSecret,
        presign: createPresigner(bucket),
        requestPdf,
        // Appelé une seule fois par lien (passage de remaining à 0) : un seul e-mail.
        onLastCopy: async (link) => {
          app.log.info({ linkId: link.linkId }, "dernier exemplaire réservé");
          await notify?.(link);
        },
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
