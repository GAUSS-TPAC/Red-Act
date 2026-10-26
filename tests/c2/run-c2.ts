/**
 * Mesure C2 : N rédacteurs tapent en continu (8 caractères/s chacun, une frappe =
 * une modification) au même endroit ; on mesure le retard de confirmation dans le
 * temps, puis on vérifie la convergence. Résultats bruts dans tests/results/c2/.
 *
 *   npm run test:c2                                   # local : serveur + DynamoDB Local
 *   npm run test:c2 -- --base-url https://xxx.cloudfront.net --bucket <BucketName>
 *
 * Options : --clients (20), --rate (8 car./s), --duration (60 s), --flush-delay (0 ms :
 * une frappe = un message ; 200 = regroupement de l'éditeur), --settle (600 s :
 * délai d'attente des confirmations, à allonger pour la variante « arrêt brutal »).
 * Variante arrêt brutal (AWS) : pendant la frappe, Alan termine l'instance temps réel ;
 * les clients se reconnectent seuls au nouveau serveur et renvoient ce qui n'a pas été
 * confirmé. --bucket permet de relire l'état depuis DynamoDB + S3 (lecture seule).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { parseArgs } from "node:util";
import { s3BlobStore, createDocumentClient } from "../../packages/realtime/src/aws.ts";
import { ensureLocalTables, isLocalDbUp, LOCAL_ENDPOINT } from "../../scripts/local-tables.ts";
import { createDocument, startRealtime, TestWriter, testToken } from "../helpers/realtime.ts";
import { checkConvergence } from "./convergence.ts";

const { values } = parseArgs({
  options: {
    clients: { type: "string", default: "20" },
    rate: { type: "string", default: "8" },
    duration: { type: "string", default: "60" },
    settle: { type: "string", default: "600" },
    // Regroupement côté client en ms (0 : une frappe = un message, le pire cas).
    "flush-delay": { type: "string", default: "0" },
    "base-url": { type: "string" },
    bucket: { type: "string" },
  },
});

const WINDOW_MS = 5_000;

async function api(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} : ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!) : null;

async function main() {
  const clients = Number(values.clients);
  const rate = Number(values.rate);
  const durationMs = Number(values.duration) * 1000;
  const remote = values["base-url"]?.replace(/\/$/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const emails = Array.from({ length: clients }, (_, i) => `c2-${stamp.toLowerCase()}-${i}@test.local`);

  let url: string;
  let docId: string;
  let tokens: string[];
  let stop = async () => {};
  const db = createDocumentClient(remote ? undefined : LOCAL_ENDPOINT);
  let blobs = remote && values.bucket ? s3BlobStore(values.bucket) : undefined;

  if (remote) {
    setDefaultAutoSelectFamilyAttemptTimeout(5000); // liaison lente du poste (voir run-c1)
    url = `${remote.replace(/^http/, "ws")}/collab`;
    // Une session après l'autre : 20 connexions simultanées dépassent parfois le délai depuis le poste.
    tokens = [];
    for (const email of emails) tokens.push((await api(remote, "/api/session", { name: "C2", email })).token as string);
    docId = (await api(remote, "/api/documents", { title: `C2 ${stamp}` }, tokens[0])).docId as string;
    for (const email of emails.slice(1)) await api(remote, `/api/documents/${docId}/editors`, { email }, tokens[0]);
  } else {
    if (!(await isLocalDbUp())) throw new Error(`DynamoDB Local injoignable (${LOCAL_ENDPOINT}) : npm run local:db`);
    await ensureLocalTables();
    const rt = await startRealtime(db);
    url = rt.url;
    blobs = rt.blobs;
    docId = await createDocument(db, emails);
    tokens = emails.map(testToken);
    stop = () => rt.server.destroy();
  }

  const flushDelay = Number(values["flush-delay"]) || undefined;
  const writers = tokens.map((token) => new TestWriter(url, docId, token, { flushDelay }));
  let disconnects = 0;
  for (const w of writers) w.provider.on("close", () => disconnects++);
  await Promise.all(writers.map((w) => w.synced(30_000)));

  // Frappe : chaque rédacteur insère un caractère au début du texte tous les 1/rate s.
  const t0 = performance.now();
  let sent = 0;
  await new Promise<void>((resolve) => {
    const timers = writers.map((w, i) =>
      setInterval(() => {
        if (w.refusal) return;
        w.insert(0, String.fromCharCode(97 + (i % 26)));
        sent++;
      }, 1000 / rate),
    );
    setTimeout(() => {
      timers.forEach(clearInterval);
      resolve();
    }, durationMs);
  });
  const typingEnd = performance.now();
  await Promise.all(writers.map((w) => w.idle(Number(values.settle) * 1000)));
  const settleMs = Math.round(performance.now() - typingEnd);

  // Retard de confirmation par fenêtre de 5 s (date d'envoi relative au début).
  const all = writers.flatMap((w) => w.confirmations).map((c) => ({ at: c.sentAt - t0, ms: c.ms }));
  const windows: { fromS: number; count: number; p50: number | null; p95: number | null; max: number | null }[] = [];
  for (let start = 0; start < durationMs; start += WINDOW_MS) {
    const ms = all.filter((c) => c.at >= start && c.at < start + WINDOW_MS).map((c) => c.ms).sort((a, b) => a - b);
    windows.push({ fromS: start / 1000, count: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: percentile(ms, 100) });
  }
  const third = Math.max(1, Math.floor(windows.length / 3));
  const avgP95 = (ws: typeof windows) => ws.reduce((s, w) => s + (w.p95 ?? 0), 0) / ws.length;
  const firstP95 = avgP95(windows.slice(0, third));
  const lastP95 = avgP95(windows.slice(-third));
  // Croissance : le retard de fin de mesure dépasse nettement celui du début.
  const growing = lastP95 > firstP95 * 1.5 && lastP95 - firstP95 > 100;

  const convergence = blobs ? await checkConvergence(db, blobs, docId, writers) : null;
  const result = {
    target: remote ? "aws" : "local",
    startedAt: new Date(Date.now() - (performance.now() - t0)).toISOString(),
    docId,
    clients,
    ratePerClient: rate,
    flushDelayMs: flushDelay ?? 0,
    durationS: durationMs / 1000,
    sent,
    confirmed: all.length,
    refusals: writers.filter((w) => w.refusal).length,
    disconnects,
    settleMs,
    latencyWindows: windows,
    latencyTrend: { firstThirdP95: Math.round(firstP95), lastThirdP95: Math.round(lastP95), growing },
    convergence,
  };
  // Verdict C2 = aucune perte et convergence. Le retard croissant est une mesure à
  // signaler (CLAUDE.md §5), pas un critère de C2 : un arrêt brutal ou une liaison
  // dégradée le fait forcément grimper sans rien perdre.
  const ok =
    result.refusals === 0 &&
    (convergence === null ||
      (convergence.identicalTexts &&
        convergence.identicalStateVectors &&
        convergence.persistedMatches &&
        convergence.missingAckedSeqs.length === 0 &&
        convergence.length === sent));

  for (const w of writers) w.destroy();
  await stop();

  mkdirSync("tests/results/c2", { recursive: true });
  const file = `tests/results/c2/${stamp}-${result.target}.json`;
  writeFileSync(file, `${JSON.stringify({ ...result, ok }, null, 2)}\n`);
  console.log(
    `${clients} rédacteurs × ${rate} car./s × ${durationMs / 1000} s : ${sent} frappes, ${all.length} confirmées, ` +
      `p95 début ${Math.round(firstP95)} ms → fin ${Math.round(lastP95)} ms${growing ? " (CROISSANT)" : ""}, ` +
      `convergence ${convergence ? JSON.stringify({ ...convergence, missingAckedSeqs: convergence.missingAckedSeqs.length }) : "non vérifiée (--bucket)"} → C2 ${ok ? "OK" : "ÉCHEC"}`,
  );
  if (growing) console.log("attention : retard de confirmation croissant (mesure à signaler, sans effet sur le verdict C2)");
  console.log(`résultats bruts : ${file}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
