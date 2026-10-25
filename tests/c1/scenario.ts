/**
 * Scénario C1 : N visiteurs sans identité cliquent en même temps sur un lien de
 * K exemplaires, répartis sur plusieurs instances API. Utilisable en local
 * (instances en mémoire + DynamoDB Local) comme contre l'URL CloudFront.
 */

export interface C1Options {
  /** Adresses des instances (ou une seule URL CloudFront). */
  baseUrls: string[];
  copies: number;
  requests: number;
  /** Champ libre pour le rapport (local, aws…). */
  target: string;
}

export interface C1Result {
  target: string;
  startedAt: string;
  copies: number;
  requests: number;
  linkId: string;
  docId: string;
  durationMs: number;
  statuses: Record<string, number>;
  /** Réponses 200/202 avec ticket : exemplaires réservés vus par les visiteurs. */
  reserved: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  /** Second clic de chaque gagnant avec son ticket. */
  replay: { statuses: Record<string, number>; sameUrl: number; newTicket: number };
  networkErrors: number;
}

interface Shot {
  status: number;
  ms: number;
  ticket?: string;
  url?: string;
}

async function json(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

export async function prepareLink(baseUrl: string, copies: number) {
  const session = await json(
    await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test C1", email: `c1-${Date.now()}@test.local` }),
    }),
  );
  const auth = { "content-type": "application/json", authorization: `Bearer ${session.token as string}` };
  const doc = await json(
    await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: `C1 ${copies} exemplaires` }),
    }),
  );
  const link = await json(
    await fetch(`${baseUrl}/api/documents/${doc.docId as string}/links`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ max: copies }),
    }),
  );
  return { docId: doc.docId as string, linkId: link.linkId as string };
}

async function shoot(baseUrl: string, linkId: string, ticket?: string): Promise<Shot> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/links/${linkId}/claim`, {
    method: "POST",
    headers: ticket ? { cookie: `ticket=${ticket}` } : {},
  });
  const body = (await response.json().catch(() => ({}))) as { url?: string };
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("ticket="));
  return {
    status: response.status,
    ms: performance.now() - started,
    ticket: cookie?.slice("ticket=".length).split(";")[0],
    url: body.url,
  };
}

const count = (values: number[]) =>
  values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!) : 0;

export async function runC1(options: C1Options, linkOverride?: { docId: string; linkId: string }): Promise<C1Result> {
  const { baseUrls, copies, requests } = options;
  const { docId, linkId } = linkOverride ?? (await prepareLink(baseUrls[0]!, copies));

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let networkErrors = 0;
  // Toutes les requêtes partent ensemble : aucune n'attend la réponse d'une autre.
  const shots = await Promise.all(
    Array.from({ length: requests }, (_, i) =>
      shoot(baseUrls[i % baseUrls.length]!, linkId).catch(() => {
        networkErrors++;
        return { status: 0, ms: 0 } as Shot;
      }),
    ),
  );
  const durationMs = Math.round(performance.now() - t0);

  const winners = shots.filter((s) => (s.status === 200 || s.status === 202) && s.ticket);
  // Second clic de chaque gagnant, sur une autre instance que la première fois.
  const replays = await Promise.all(
    winners.map((w, i) =>
      shoot(baseUrls[(i + 1) % baseUrls.length]!, linkId, w.ticket).then((r) => ({ first: w, again: r })),
    ),
  );

  const latencies = shots.filter((s) => s.status).map((s) => s.ms).sort((a, b) => a - b);
  return {
    target: options.target,
    startedAt,
    copies,
    requests,
    linkId,
    docId,
    durationMs,
    statuses: count(shots.map((s) => s.status)),
    reserved: winners.length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.round(latencies.at(-1) ?? 0),
    },
    replay: {
      statuses: count(replays.map((r) => r.again.status)),
      sameUrl: replays.filter((r) => r.first.url && r.first.url === r.again.url).length,
      newTicket: replays.filter((r) => r.again.ticket).length,
    },
    networkErrors,
  };
}
