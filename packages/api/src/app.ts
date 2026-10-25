import Fastify, { type FastifyServerOptions } from "fastify";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  // Contrôle de santé de l'ALB et de l'ASG : ne dépend d'aucun service AWS,
  // pour qu'une lenteur de DynamoDB ne fasse pas remplacer toutes les instances.
  app.get("/sante", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { statut: "ok" };
  });

  return app;
}
