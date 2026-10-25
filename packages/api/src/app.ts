import Fastify, { type FastifyServerOptions } from "fastify";
import { registerRoutes, type RouteDeps } from "./routes.ts";
import { registerStatic } from "./static.ts";

/** Sans `deps`, seule la route de santé est montée (tests, démarrage). */
export function buildApp(options: FastifyServerOptions = {}, deps?: RouteDeps, publicDir?: string) {
  const app = Fastify(options);

  // Contrôle de santé de l'ALB et de l'ASG : ne dépend d'aucun service AWS,
  // pour qu'une lenteur de DynamoDB ne fasse pas remplacer toutes les instances.
  app.get("/sante", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { statut: "ok" };
  });

  if (deps) registerRoutes(app, deps);
  if (publicDir) registerStatic(app, publicDir);

  return app;
}
