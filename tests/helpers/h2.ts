/**
 * Requêtes HTTP/2 multiplexées vers CloudFront, pour les tests lancés depuis un poste.
 *
 * Un poste derrière une box ne sait pas ouvrir 1 000 connexions TCP+TLS en même
 * temps (délais de connexion dépassés) : les clics n'atteignent jamais AWS. En
 * HTTP/2, quelques connexions portent chacune jusqu'à 100 flux simultanés ;
 * CloudFront transmet ensuite chaque flux à l'ALB comme une requête distincte,
 * donc la concurrence vue par l'API reste entière.
 */
import http2 from "node:http2";

export interface H2Response {
  status: number;
  setCookies: string[];
  body: string;
}

export interface H2Pool {
  request(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<H2Response>;
  close(): void;
}

/** Flux simultanés par connexion annoncés par CloudFront. */
export const H2_STREAMS_PER_SESSION = 100;

export async function createH2Pool(origin: string, sessions: number): Promise<H2Pool> {
  const pool = await Promise.all(
    Array.from(
      { length: sessions },
      () =>
        new Promise<http2.ClientHttp2Session>((resolve, reject) => {
          const session = http2.connect(origin);
          session.once("connect", () => resolve(session));
          session.once("error", reject);
        }),
    ),
  );
  let next = 0;

  return {
    request(path, init = {}) {
      const session = pool[next++ % pool.length]!;
      return new Promise((resolve, reject) => {
        const stream = session.request({ ":method": init.method ?? "GET", ":path": path, ...init.headers });
        let status = 0;
        let setCookies: string[] = [];
        let body = "";
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          status = Number(headers[":status"]);
          const raw = headers["set-cookie"];
          setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        });
        stream.on("data", (chunk: string) => (body += chunk));
        stream.on("end", () => resolve({ status, setCookies, body }));
        stream.on("error", reject);
        stream.end();
      });
    },
    close() {
      for (const session of pool) session.close();
    },
  };
}
