// Copy PGlite's wasm + Postgres data-image assets into `public/pglite/` so the
// SharedWorker (lib/wiki-host.worker.ts) can fetch them by absolute path and pass them
// to `PGlite.create(dataDir, { wasmModule, fsBundle })` explicitly.
//
// Why not let webpack emit them? PGlite's pre-built `dist/index.js` references the assets
// via `new URL("postgres.wasm", import.meta.url)` from inside an already-bundled
// node_modules chunk. Webpack *can* emit those for a worker chunk, but it is fragile
// across Next's asset rules (the "path argument … undefined" worker/wasm failure). Passing
// `wasmModule`/`fsBundle` explicitly bypasses PGlite's implicit fetch entirely — so the
// assets just need to be reachable at a stable URL. This copy (run on predev/prebuild) is
// that stable URL; `public/pglite/` is gitignored and regenerated from node_modules.
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "node_modules", "@electric-sql", "pglite", "dist");
const dst = join(root, "public", "pglite");

// Copy only when out of date. These are ~13 MB; rewriting them on every predev/prebuild
// churns mtimes under `public/` for no reason, and the benchmark build runs alongside a live
// `next dev` that watches this tree.
function upToDate(from, to) {
  try {
    const a = statSync(from);
    const b = statSync(to);
    return a.size === b.size && b.mtimeMs >= a.mtimeMs;
  } catch {
    return false;
  }
}

mkdirSync(dst, { recursive: true });
for (const file of ["postgres.wasm", "postgres.data"]) {
  if (upToDate(join(src, file), join(dst, file))) {
    console.log(`[copy-pglite-assets] ${file} up to date`);
    continue;
  }
  copyFileSync(join(src, file), join(dst, file));
  console.log(`[copy-pglite-assets] ${file} → public/pglite/${file}`);
}
