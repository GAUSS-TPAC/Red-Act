// Un bundle esbuild par serveur, déployé tel quel (pas de npm install sur les instances).
import { build } from "esbuild";

const targets = [{ entry: "packages/api/src/server.ts", outfile: "packages/api/dist/server.cjs" }];

for (const { entry, outfile } of targets) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    logLevel: "warning",
  });
  console.log(`bundle : ${outfile}`);
}
