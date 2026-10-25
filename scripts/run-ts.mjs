// Exécute un point d'entrée TypeScript : esbuild le compile (avec les paquets
// @editeur/* du monorepo), les autres dépendances restent dans node_modules.
// Utilisé par l'app CDK et les scripts locaux, sans ts-node ni tsx.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage : node scripts/run-ts.mjs <fichier.ts> [arguments…]");
  process.exit(2);
}

const outdir = join(process.cwd(), "node_modules", ".cache", "run-ts");
mkdirSync(outdir, { recursive: true });
const outfile = join(outdir, `${basename(entry, ".ts")}.cjs`);

await build({
  entryPoints: [resolve(entry)],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "warning",
  plugins: [
    {
      name: "externes-hors-monorepo",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (a) =>
          a.path.startsWith("@editeur/") ? undefined : { path: a.path, external: true },
        );
      },
    },
  ],
});

const result = spawnSync(process.execPath, [outfile, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
