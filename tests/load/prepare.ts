/**
 * Préparation du test de charge : un document, un lien de K exemplaires qui ouvre
 * dans `--opens-in` minutes (l'API programme la montée de l'ASG 10 min avant).
 * Écrit {docId, linkId, opensAt, copies} sur la sortie standard.
 *
 *   node prepare.cjs --base-url https://xxx.cloudfront.net --copies 5000 --opens-in 12
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    copies: { type: "string", default: "5000" },
    "opens-in": { type: "string", default: "12" },
  },
});

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} : ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const base = values["base-url"]!.replace(/\/$/, "");
  const opensAt = new Date(Date.now() + Number(values["opens-in"]) * 60_000);
  opensAt.setUTCSeconds(0, 0);
  const token = (await post(base, "/api/session", { name: "Charge", email: `charge-${Date.now()}@test.local` })).token as string;
  const docId = (await post(base, "/api/documents", { title: "Journal — test de charge" }, token)).docId as string;
  const link = await post(base, `/api/documents/${docId}/links`, { max: Number(values.copies), opensAt: opensAt.toISOString() }, token);
  console.log(JSON.stringify({ docId, linkId: link.linkId, opensAt: opensAt.toISOString(), copies: Number(values.copies) }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
