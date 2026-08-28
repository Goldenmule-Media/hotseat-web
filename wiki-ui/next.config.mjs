/** @type {import('next').NextConfig} */
const nextConfig = {
  // The benchmark harness needs a PRODUCTION build (dev compiles on demand, ships dev React,
  // and Strict Mode double-invokes effects), but a plain `next build` would overwrite the
  // `.next/` of the always-running `next dev` and kill it. Both `build` and `start` read this,
  // so the bench runs entirely inside `.next-bench/` and never touches the dev server's output.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Server-only values baked into the build. The host exposes its configured variables to the
  // BUILD but not to the SSR runtime, and the artifact is `.next` alone, so an env file written
  // during the build never ships: inlining is the only path from a build-time value to a running
  // route handler. Every name here is referenced ONLY under lib/server/, so none reaches a client
  // bundle — the substitution lands where the name is written, and it is not written in client
  // code. Absent values are omitted so a local build inlines nothing.
  env: {
    ...(process.env.ANTHROPIC_API_KEY !== undefined ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.WIKI_STREAM_BASE_URL !== undefined ? { WIKI_STREAM_BASE_URL: process.env.WIKI_STREAM_BASE_URL } : {}),
  },
  // `wiki` and `wiki-models` are published as extensionless TypeScript SOURCE
  // (their package `exports` point at `./src/**/*.ts`, moduleResolution: Bundler).
  // Next must transpile them; webpack/turbopack resolve extensionless `.ts`
  // imports natively, so there is no ERR_MODULE_NOT_FOUND (that is Node-ESM-only).
  //
  // `@electric-sql/pglite` is transpiled too: the engine + PGlite now run inside a
  // `{type:"module"}` SharedWorker (lib/wiki-host.worker.ts). Webpack 5 detects that
  // worker entry from the `new SharedWorker(new URL("./…", import.meta.url))` literal
  // and compiles it in the SAME compilation as the page graph, so `transpilePackages`
  // and the SWC `.ts` rule cover the worker and everything it imports.
  transpilePackages: ["wiki", "wiki-models", "@electric-sql/pglite"],
  // This is a standalone app nested in the monorepo; pin the trace root to this
  // directory so Next doesn't pick the monorepo-root lockfile.
  outputFileTracingRoot: import.meta.dirname,
  // NB: do NOT override `output.publicPath`/`globalObject` here. Next's default client
  // publicPath is an absolute `/_next/` (worker-safe — no `document` lookup), and its
  // client `globalObject` is already `self`; setting `publicPath:"auto"` globally breaks
  // the Node server runtime ("Automatic publicPath is not supported in this browser").
  webpack: (config, { isServer }) => {
    // Keep the {type:"module"} SharedWorker (lib/wiki-host.worker.ts) a SINGLE self-contained
    // chunk. Next's client output is NOT ESM, so webpack loads any *split* worker chunk via
    // `importScripts()` — which a module worker doesn't have, so it would throw at runtime when
    // pulling in the big PGlite chunk. Excluding the worker entry from chunk-splitting inlines
    // its deps (PGlite + engine) into the one worker chunk, so it never needs `importScripts`.
    if (!isServer) {
      const sc = config.optimization?.splitChunks;
      if (sc && typeof sc === "object") {
        const prev = sc.chunks;
        sc.chunks = (chunk) => {
          const name = typeof chunk.name === "string" ? chunk.name : "";
          if (name.startsWith("wiki-host")) return false; // never split the worker entry
          if (typeof prev === "function") return prev(chunk);
          if (prev === "initial") return chunk.canBeInitial();
          if (prev === "async") return !chunk.canBeInitial();
          return true; // Next default ("all")
        };
      }
    }
    return config;
  },
};

export default nextConfig;
