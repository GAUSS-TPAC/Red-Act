/**
 * Front statique servi par l'API (CLAUDE.md §3), sans dépendance supplémentaire :
 *   - /assets/* : fichiers nommés par leur empreinte (esbuild), mis en cache par
 *     CloudFront et les navigateurs (le pic de visiteurs ne touche pas les instances) ;
 *   - toute autre page (/, /doc/…, /l/…) : index.html, jamais mis en cache.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

export function registerStatic(app: FastifyInstance, publicDir: string) {
  const assetsDir = path.join(publicDir, "assets");

  app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
    const file = request.params.file;
    // Pas de « .. » ni de sous-dossier : seulement un nom de fichier du dossier assets.
    if (!/^[\w.-]+$/.test(file) || file.startsWith(".")) return reply.code(404).send();
    try {
      const body = await readFile(path.join(assetsDir, file));
      return reply
        .header("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(body);
    } catch {
      return reply.code(404).send();
    }
  });

  let index: Buffer | undefined;
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ erreur: "introuvable" });
    }
    index ??= await readFile(path.join(publicDir, "index.html"));
    return reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache").send(index);
  });
}
