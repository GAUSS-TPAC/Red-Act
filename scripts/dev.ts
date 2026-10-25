/**
 * Environnement de développement local, sans aucune ressource AWS :
 *   http://localhost:3000  — front + API ; /collab relayé vers le serveur temps réel.
 * DynamoDB Local (npm run local:db) ; instantanés et PDF en mémoire ; demandes de PDF
 * passées directement au générateur (pas de SQS). Prérequis : npm run build (front).
 *
 *   npm run dev
 */
import { connect } from "node:net";
import * as path from "node:path";
import { buildApp } from "../packages/api/src/app.ts";
import { ClaimService } from "../packages/api/src/links/claim.ts";
import { createDocumentClient } from "../packages/realtime/src/aws.ts";
import { PdfGenerator } from "../packages/realtime/src/pdf/generator.ts";
import { renderPdf } from "../packages/realtime/src/pdf/render.ts";
import { createRealtimeServer } from "../packages/realtime/src/realtime.ts";
import { memoryBlobStore } from "../packages/realtime/src/store.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "./local-tables.ts";

const SECRET = "secret-de-developpement-local-32-octets!";
const API_PORT = 3000;
const REALTIME_PORT = 1234;

async function main() {
  if (!(await isLocalDbUp())) throw new Error(`DynamoDB Local injoignable (${LOCAL_ENDPOINT}) : npm run local:db`);
  await ensureLocalTables();
  const db = createDocumentClient(LOCAL_ENDPOINT);
  const blobs = memoryBlobStore();
  const log = { info: (o: unknown, m: string) => console.log(m, o), error: (o: unknown, m: string) => console.error(m, o) };

  const { server: realtime, openState } = createRealtimeServer({ db, blobs, hmacSecret: SECRET, port: REALTIME_PORT, log });
  await realtime.listen();

  const generator = new PdfGenerator({ db, blobs, openState, render: (input) => renderPdf(input), log });
  // Comme la file SQS : la demande part, le clic n'attend pas la génération.
  const requestPdf = async (docId: string, seqRequis: number) => {
    void generator.request(docId, seqRequis).catch((error: unknown) => log.error({ error }, "PDF"));
  };

  const app = buildApp(
    { logger: { level: "warn" } },
    {
      db,
      hmacSecret: SECRET,
      requestPdf,
      adminToken: "admin-local", // tableau de bord : http://localhost:3000/admin
      claims: new ClaimService({
        db,
        hmacSecret: SECRET,
        presign: async (key) => `/dev-fichiers/${key}`, // à la place d'une URL S3 pré-signée
        requestPdf,
        onLastCopy: async (link) => log.info({ linkId: link.linkId }, "dernier exemplaire"),
        log,
      }),
    },
    path.resolve("packages/api/dist/public"),
  );
  app.get<{ Params: { "*": string } }>("/dev-fichiers/*", async (request, reply) => {
    const body = blobs.blobs.get(request.params["*"]);
    if (!body) return reply.code(404).send();
    return reply.header("Content-Type", "application/pdf").send(Buffer.from(body));
  });

  // /collab : la connexion WebSocket est relayée telle quelle au serveur temps réel
  // (sur AWS, c'est l'ALB qui route /collab* vers lui).
  app.server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/collab")) return socket.destroy();
    const upstream = connect(REALTIME_PORT, "127.0.0.1", () => {
      const headers = Object.entries(request.headers).map(([k, v]) => `${k}: ${String(v)}`);
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await app.listen({ host: "127.0.0.1", port: API_PORT });
  console.log(`Éditeur en local : http://localhost:${API_PORT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
