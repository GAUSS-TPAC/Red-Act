import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp({ logger: true });

app.listen({ host: "0.0.0.0", port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
