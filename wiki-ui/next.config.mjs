/** @type {import('next').NextConfig} */
const nextConfig = {
  // `wiki` and `wiki-models` are published as extensionless TypeScript SOURCE
  // (their package `exports` point at `./src/**/*.ts`, moduleResolution: Bundler).
  // Next must transpile them; webpack/turbopack resolve extensionless `.ts`
  // imports natively, so there is no ERR_MODULE_NOT_FOUND (that is Node-ESM-only).
  transpilePackages: ["wiki", "wiki-models"],
  // This is a standalone app nested in the monorepo; pin the trace root to this
  // directory so Next doesn't pick the monorepo-root lockfile.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
