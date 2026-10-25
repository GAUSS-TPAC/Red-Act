/**
 * Lance le scénario C1 et écrit les résultats bruts horodatés dans tests/results/c1/.
 *
 *   npm run test:c1                                  # local : 3 instances + DynamoDB Local
 *   npm run test:c1 -- --base-url https://xxx.cloudfront.net --copies 500 --requests 2000
 *
 * Options : --copies (500), --requests (1200), --runs (3), --base-url (sinon local).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { createDocumentClient } from "../../packages/api/src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";
import { createLocalApi } from "../helpers/local-api.ts";
import { runC1 } from "./scenario.ts";
import { dbState } from "./verify-db.ts";

const { values } = parseArgs({
  options: {
    copies: { type: "string", default: "500" },
    requests: { type: "string", default: "1200" },
    runs: { type: "string", default: "3" },
    "base-url": { type: "string" },
  },
});

async function main() {
  const copies = Number(values.copies);
  const requests = Number(values.requests);
  const remote = values["base-url"]?.replace(/\/$/, "");

  let baseUrls: string[];
  let close = async () => {};
  const db = remote ? undefined : createDocumentClient(LOCAL_ENDPOINT);
  if (remote) {
    baseUrls = [remote];
  } else {
    if (!(await isLocalDbUp())) throw new Error(`DynamoDB Local injoignable (${LOCAL_ENDPOINT}) : npm run local:db`);
    await ensureLocalTables();
    const apis = Array.from({ length: 3 }, () => createLocalApi());
    baseUrls = [];
    for (const api of apis) {
      await api.app.listen({ host: "127.0.0.1", port: 0 });
      baseUrls.push(`http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`);
    }
    close = async () => void (await Promise.all(apis.map((a) => a.app.close())));
  }

  const target = remote ? "aws" : "local";
  const runs = [];
  try {
    for (let i = 0; i < Number(values.runs); i++) {
      const result = await runC1({ baseUrls, copies, requests, target });
      // Sur AWS, l'état en base se vérifie par le tableau de bord (étape 6) ou en lecture seule.
      const db_state = db ? await dbState(db, result.linkId) : null;
      const ok =
        result.reserved === copies &&
        (result.statuses["410"] ?? 0) === requests - copies &&
        result.networkErrors === 0 &&
        (!db_state || (db_state.remaining === 0 && db_state.reservations === copies));
      runs.push({ ...result, db: db_state, ok });
      console.log(
        `tirage ${i + 1} : ${result.reserved}/${copies} réservés, statuts ${JSON.stringify(result.statuses)}, ` +
          `base ${JSON.stringify(db_state)}, p95 ${result.latencyMs.p95} ms → ${ok ? "OK" : "ÉCHEC"}`,
      );
    }
  } finally {
    await close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("tests/results/c1", { recursive: true });
  const file = `tests/results/c1/${stamp}-${target}.json`;
  writeFileSync(file, `${JSON.stringify({ copies, requests, runs }, null, 2)}\n`);
  console.log(`résultats bruts : ${file}`);
  if (runs.some((r) => !r.ok)) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
