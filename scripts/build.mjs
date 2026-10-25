// Un bundle esbuild par serveur, déployé tel quel (pas de npm install sur les instances).
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

const targets = [
  { entry: "packages/api/src/server.ts", outfile: "packages/api/dist/server.cjs" },
  { entry: "packages/realtime/src/server.ts", outfile: "packages/realtime/dist/server.cjs" },
  // Worker thread de rendu PDF, chargé par le serveur temps réel depuis le même dossier.
  { entry: "packages/realtime/src/pdf/worker.ts", outfile: "packages/realtime/dist/pdf-worker.cjs" },
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

// pdfkit charge ses polices standard par un require dynamique de `#standard-fonts/…`
// (champ "imports" de son package.json), qu'esbuild ne peut pas inclure dans le bundle.
// On livre donc ces modules (192 Ko) à côté du bundle, avec le même champ "imports".
cpSync("node_modules/pdfkit/js/standard-fonts", "packages/realtime/dist/standard-fonts", {
  recursive: true,
  filter: (src) => !src.endsWith(".mjs"),
});
writeFileSync(
  "packages/realtime/dist/package.json",
  `${JSON.stringify({ private: true, imports: { "#standard-fonts/*": "./standard-fonts/*.cjs" } }, null, 2)}\n`,
);
console.log("polices pdfkit : packages/realtime/dist/standard-fonts");

// Front : bundle navigateur servi par l'API (dist/public). Fichiers nommés par leur
// empreinte, mis en cache par CloudFront ; index.html les référence.
const publicDir = "packages/api/dist/public";
rmSync(publicDir, { recursive: true, force: true });
const web = await build({
  entryPoints: ["packages/web/src/main.ts"],
  outdir: `${publicDir}/assets`,
  entryNames: "[name]-[hash]",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});
const outputs = Object.keys(web.metafile.outputs).map((file) => path.basename(file));
const js = outputs.find((f) => f.endsWith(".js"));
const css = outputs.find((f) => f.endsWith(".css"));
writeFileSync(
  `${publicDir}/index.html`,
  readFileSync("packages/web/index.html", "utf8").replace("%JS%", js).replace("%CSS%", css),
);
console.log(`front : ${publicDir} (${js}, ${css})`);
