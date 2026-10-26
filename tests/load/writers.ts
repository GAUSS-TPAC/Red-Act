/**
 * Les 300 rédacteurs du pic (C5) : vrais clients Hocuspocus + Yjs, répartis sur
 * `--docs` documents, chacun tape `--rate` caractères/s pendant `--duration` s.
 * Mesure le retard de confirmation par fenêtre de 30 s, puis vérifie que les copies
 * de chaque document ont convergé. Résultat JSON dans `--out`.
 *
 *   node writers.cjs --base-url https://xxx.cloudfront.net --writers 300 --docs 30 --rate 2 --duration 900 --out writers.json
 *
 * Le générateur ne doit pas être le goulot : un seul processus Node pour 300 clients
 * saturait (test du 25/10 : 100 % de boucle d'événements, retard mesuré croissant alors
 * que le serveur restait à ~40 %). Les rédacteurs sont donc répartis sur `--procs`
 * processus (un par cœur par défaut), chaque document entier dans un seul processus
 * (vérification de convergence locale), et chaque processus mesure sa propre charge
 * (`generateurElu`) : une fenêtre où il dépasse ~90 % n'est pas une mesure du serveur.
 * Chaque rédacteur tape à son propre curseur (comme un humain), pas à une position
 * aléatoire : Yjs retrouve une position voisine de la précédente sans parcourir le texte.
 */
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { TestWriter, stateVector, waitFor } from "../helpers/realtime.ts";

const WINDOW_MS = 30_000;

interface ChildTask {
  url: string;
  rate: number;
  durationMs: number;
  writers: { docId: string; token: string; letter: string }[];
}

interface ChildResult {
  sent: number;
  refusals: number;
  /** [envoi (ms depuis startAt), retard (ms)]. */
  confirmations: [number, number][];
  /** Utilisation de la boucle d'événements par fenêtre de 30 s. */
  elu: number[];
  docs: { docId: string; clients: number; converged: boolean }[];
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!) : null;

// ---------------------------------------------------------------- processus fils
async function child(task: ChildTask): Promise<ChildResult> {
  const writers: TestWriter[] = [];
  for (const [i, w] of task.writers.entries()) {
    writers.push(new TestWriter(task.url, w.docId, w.token));
    if (i % 20 === 19) await Promise.all(writers.slice(-20).map((x) => x.synced(60_000)));
  }
  await Promise.all(writers.map((x) => x.synced(60_000)));
  // Départ commun : le principal l'annonce quand tous les processus sont connectés.
  const startAt = await new Promise<number>((resolve) => {
    process.once("message", (m: { startAt: number }) => resolve(m.startAt));
    process.send!({ type: "connectes" });
  });
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));

  const elu: number[] = [];
  let last = performance.eventLoopUtilization();
  const eluTimer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    elu.push(Math.round(performance.eventLoopUtilization(now, last).utilization * 100));
    last = now;
  }, WINDOW_MS);

  let sent = 0;
  await new Promise<void>((resolve) => {
    const timers = writers.map((writer, i) => {
      let cursor = Math.floor(Math.random() * (writer.text.length + 1));
      return setInterval(() => {
        if (writer.refusal) return;
        cursor = Math.min(cursor, writer.text.length);
        writer.insert(cursor++, task.writers[i]!.letter);
        sent++;
      }, 1000 / task.rate);
    });
    setTimeout(() => (timers.forEach(clearInterval), resolve()), task.durationMs);
  });
  clearInterval(eluTimer);
  await Promise.all(writers.map((writer) => writer.idle(600_000).catch(() => undefined)));

  const origin = performance.timeOrigin - startAt;
  const byDoc = new Map<string, TestWriter[]>();
  for (const [i, writer] of writers.entries()) {
    const docId = task.writers[i]!.docId;
    byDoc.set(docId, [...(byDoc.get(docId) ?? []), writer]);
  }
  // La confirmation d'un rédacteur peut précéder la diffusion de sa modification aux
  // autres copies (envoyée à part) : on laisse 30 s aux dernières diffusions avant de
  // comparer. Une vraie divergence reste visible après ce délai.
  const same = (clients: TestWriter[]) => clients.every((c) => JSON.stringify(stateVector(c.doc)) === JSON.stringify(stateVector(clients[0]!.doc)));
  await waitFor(() => [...byDoc.values()].every(same), 30_000, "diffusion des dernières modifications").catch(() => undefined);
  const result: ChildResult = {
    sent,
    refusals: writers.filter((w) => w.refusal).length,
    confirmations: writers.flatMap((w) => w.confirmations.map((c) => [Math.round(origin + c.sentAt), Math.round(c.ms)] as [number, number])),
    elu,
    docs: [...byDoc].map(([docId, clients]) => {
      const texts = clients.map((c) => c.text.toString());
      const vectors = clients.map((c) => JSON.stringify(stateVector(c.doc)));
      return { docId, clients: clients.length, converged: texts.every((t) => t === texts[0]) && vectors.every((v) => v === vectors[0]) };
    }),
  };
  for (const writer of writers) writer.destroy();
  return result;
}

if (process.env.REDACTEURS_FILS === "1") {
  process.once("message", (task: ChildTask) => {
    child(task)
      .then((result) => process.send!({ type: "resultat", result }, () => process.exit(0)))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// ---------------------------------------------------------------- processus principal
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
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      writers: { type: "string", default: "300" },
      docs: { type: "string", default: "30" },
      rate: { type: "string", default: "2" },
      duration: { type: "string", default: "900" },
      procs: { type: "string", default: String(availableParallelism()) },
      out: { type: "string", default: "writers.json" },
    },
  });
  const base = values["base-url"]!.replace(/\/$/, "");
  const count = Number(values.writers);
  const docCount = Number(values.docs);
  const rate = Number(values.rate);
  const durationMs = Number(values.duration) * 1000;
  const procs = Math.max(1, Math.min(Number(values.procs), docCount));
  const stamp = Date.now();

  // Identités, documents partagés (par paquets pour ne pas tout ouvrir d'un coup).
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 20) {
    tokens.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(20, count - i) }, (_, k) =>
          post(base, "/api/session", { name: `R${i + k}`, email: `charge-${stamp}-${i + k}@test.local` }).then((r) => r.token as string),
        ),
      )),
    );
  }
  const docs: string[] = [];
  for (let d = 0; d < docCount; d++) {
    const owner = d % count;
    const docId = (await post(base, "/api/documents", { title: `Charge ${d}` }, tokens[owner])).docId as string;
    for (let w = d; w < count; w += docCount) {
      if (w !== owner) await post(base, `/api/documents/${docId}/editors`, { email: `charge-${stamp}-${w}@test.local` }, tokens[owner]);
    }
    docs.push(docId);
  }

  // Le document d (et tous ses rédacteurs) va au processus d % procs.
  const url = `${base.replace(/^http/, "ws")}/collab`;
  const tasks: ChildTask[] = Array.from({ length: procs }, () => ({ url, rate, durationMs, writers: [] }));
  for (let w = 0; w < count; w++) {
    const d = w % docCount;
    tasks[d % procs]!.writers.push({ docId: docs[d]!, token: tokens[w]!, letter: String.fromCharCode(97 + (w % 26)) });
  }

  // Connexion de tous les processus, puis départ commun.
  const children = tasks.map(() => fork(process.argv[1]!, [], { env: { ...process.env, REDACTEURS_FILS: "1" } }));
  let connected = 0;
  const allConnected = new Promise<void>((resolve) =>
    children.forEach((c) => c.on("message", (m: { type: string }) => m.type === "connectes" && ++connected === procs && resolve())),
  );
  const results = children.map(
    (c) =>
      new Promise<ChildResult>((resolve, reject) => {
        c.on("message", (m: { type: string; result?: ChildResult }) => m.type === "resultat" && resolve(m.result!));
        c.on("exit", (code) => code !== 0 && reject(new Error(`processus rédacteurs : code ${code}`)));
      }),
  );
  children.forEach((c, i) => c.send(tasks[i]!));
  await allConnected;
  const startAt = Date.now() + 1_000;
  children.forEach((c) => c.send({ startAt }));
  console.error(`${count} rédacteurs connectés sur ${docCount} documents (${procs} processus)`);
  const done = await Promise.all(results);

  const all = done.flatMap((r) => r.confirmations);
  const windows = [];
  for (let start = 0; start < durationMs; start += WINDOW_MS) {
    const ms = all.filter(([at]) => at >= start && at < start + WINDOW_MS).map(([, m]) => m).sort((a, b) => a - b);
    const elu = done.map((r) => r.elu[start / WINDOW_MS]).filter((e): e is number => e !== undefined);
    windows.push({
      fromS: start / 1000,
      count: ms.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: percentile(ms, 100),
      generateurElu: elu.length ? Math.max(...elu) : null,
    });
  }
  const perDoc = done.flatMap((r) => r.docs);
  const sent = done.reduce((s, r) => s + r.sent, 0);
  const result = {
    writers: count,
    docs: docCount,
    ratePerWriter: rate,
    durationS: durationMs / 1000,
    procs,
    expected: Math.floor(count * rate * (durationMs / 1000)),
    sent,
    confirmed: all.length,
    refusals: done.reduce((s, r) => s + r.refusals, 0),
    latencyWindows: windows,
    convergedDocs: perDoc.filter((d) => d.converged).length,
    perDoc,
  };
  writeFileSync(values.out!, `${JSON.stringify(result, null, 2)}\n`);
  const saturated = windows.filter((w) => (w.generateurElu ?? 0) > 90).length;
  console.error(
    `rédacteurs : ${sent} frappes (${result.expected} prévues), ${all.length} confirmées, ` +
      `${result.convergedDocs}/${docCount} documents convergents` +
      (saturated ? ` ; ATTENTION : générateur saturé sur ${saturated} fenêtre(s)` : ""),
  );
  process.exit(0);
}
