/**
 * Les 300 rédacteurs du pic (C5) : vrais clients Hocuspocus + Yjs, répartis sur
 * `--docs` documents, chacun tape `--rate` caractères/s pendant `--duration` s.
 * Mesure le retard de confirmation par fenêtre de 30 s, puis vérifie que les copies
 * de chaque document ont convergé. Résultat JSON dans `--out`.
 *
 *   node writers.cjs --base-url https://xxx.cloudfront.net --writers 300 --docs 30 --rate 2 --duration 900 --out writers.json
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { TestWriter, stateVector } from "../helpers/realtime.ts";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    writers: { type: "string", default: "300" },
    docs: { type: "string", default: "30" },
    rate: { type: "string", default: "2" },
    duration: { type: "string", default: "900" },
    out: { type: "string", default: "writers.json" },
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

const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!) : null;

async function main() {
  const base = values["base-url"]!.replace(/\/$/, "");
  const count = Number(values.writers);
  const docCount = Number(values.docs);
  const rate = Number(values.rate);
  const durationMs = Number(values.duration) * 1000;
  const stamp = Date.now();

  // Identités, documents partagés, connexions (par paquets pour ne pas tout ouvrir d'un coup).
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
  const url = `${base.replace(/^http/, "ws")}/collab`;
  const writers: { writer: TestWriter; doc: number }[] = [];
  for (let w = 0; w < count; w++) {
    writers.push({ writer: new TestWriter(url, docs[w % docCount]!, tokens[w]!), doc: w % docCount });
    if (w % 20 === 19) await Promise.all(writers.slice(-20).map((x) => x.writer.synced(60_000)));
  }
  await Promise.all(writers.map((x) => x.writer.synced(60_000)));
  console.error(`${count} rédacteurs connectés sur ${docCount} documents`);

  const t0 = performance.now();
  let sent = 0;
  await new Promise<void>((resolve) => {
    const timers = writers.map(({ writer }, i) =>
      setInterval(() => {
        if (writer.refusal) return;
        writer.insert(Math.floor(Math.random() * (writer.text.length + 1)), String.fromCharCode(97 + (i % 26)));
        sent++;
      }, 1000 / rate),
    );
    setTimeout(() => (timers.forEach(clearInterval), resolve()), durationMs);
  });
  await Promise.all(writers.map(({ writer }) => writer.idle(600_000).catch(() => undefined)));

  const all = writers.flatMap(({ writer }) => writer.confirmations).map((c) => ({ at: c.sentAt - t0, ms: c.ms }));
  const windows = [];
  for (let start = 0; start < durationMs; start += 30_000) {
    const ms = all.filter((c) => c.at >= start && c.at < start + 30_000).map((c) => c.ms).sort((a, b) => a - b);
    windows.push({ fromS: start / 1000, count: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: percentile(ms, 100) });
  }
  const perDoc = docs.map((docId, d) => {
    const clients = writers.filter((x) => x.doc === d).map((x) => x.writer);
    const texts = clients.map((c) => c.text.toString());
    const vectors = clients.map((c) => JSON.stringify(stateVector(c.doc)));
    return { docId, clients: clients.length, converged: texts.every((t) => t === texts[0]) && vectors.every((v) => v === vectors[0]) };
  });
  const result = {
    writers: count,
    docs: docCount,
    ratePerWriter: rate,
    durationS: durationMs / 1000,
    sent,
    confirmed: all.length,
    refusals: writers.filter(({ writer }) => writer.refusal).length,
    latencyWindows: windows,
    convergedDocs: perDoc.filter((d) => d.converged).length,
    perDoc,
  };
  writeFileSync(values.out!, `${JSON.stringify(result, null, 2)}\n`);
  console.error(`rédacteurs : ${sent} frappes, ${all.length} confirmées, ${result.convergedDocs}/${docCount} documents convergents`);
  for (const { writer } of writers) writer.destroy();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
