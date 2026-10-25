// Un bundle esbuild par serveur, déployé tel quel (pas de npm install sur les instances).
import { build } from "esbuild";

const targets = [
  { entry: "packages/api/src/server.ts", outfile: "packages/api/dist/server.cjs" },
  { entry: "packages/realtime/src/server.ts", outfile: "packages/realtime/dist/server.cjs" },
];

for (const { entry, outfile } of targets) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    // Certaines dépendances ESM (crossws, utilisé par Hocuspocus) lisent import.meta.url,
    // vide dans un bundle CJS : on le remplace par l'URL du fichier bundle.
    define: { "import.meta.url": "__bundleUrl" },
    banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' },
    logLevel: "warning",
  });
  console.log(`bundle : ${outfile}`);
}
