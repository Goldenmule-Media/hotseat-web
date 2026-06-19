/**
 * Runtime configuration (plan step 2). The wiki-server Durable Stream base URL and
 * namespace are configuration, not hardcoded (constraint #4). Because the engine runs
 * in the browser (Q1), these are read from `NEXT_PUBLIC_*` env vars so they are inlined
 * into the client bundle at build time.
 */
import type { IPageType } from "wiki";
import { pageTypes } from "./models";

export interface WikiUiConfig {
  /** wiki-server Durable Streams base URL, e.g. "http://127.0.0.1:4437". */
  readonly streamBaseUrl: string;
  /** Stream namespace — must match the server's WIKI_MCP_NAMESPACE (default "default"). */
  readonly namespace: string;
  /**
   * Base URL of the LOCAL wiki-mirror health endpoint. Resolved INDEPENDENTLY of
   * {@link streamBaseUrl}: the mirror runs on the user's own machine even when the
   * wiki-server is remote, so this always points at localhost.
   */
  readonly mirrorHealthUrl: string;
  /** Page types the UI can render — resolved from configured model bundles at build time. */
  readonly pageTypes: readonly IPageType[];
  /**
   * Git provenance of THIS build, captured at build time by scripts/write-build-info.mjs
   * and inlined as NEXT_PUBLIC_*. Lets you confirm which commit a deploy is actually
   * serving. `null` when the build ran without git info (e.g. a bare `next build`).
   */
  readonly build: { readonly branch: string; readonly commit: string; readonly time: string } | null;
}

export function getConfig(): WikiUiConfig {
  const commit = process.env.NEXT_PUBLIC_BUILD_COMMIT;
  const branch = process.env.NEXT_PUBLIC_BUILD_BRANCH;
  return {
    streamBaseUrl: process.env.NEXT_PUBLIC_WIKI_STREAM_BASE_URL ?? "http://127.0.0.1:4437",
    namespace: process.env.NEXT_PUBLIC_WIKI_NAMESPACE ?? "default",
    mirrorHealthUrl: process.env.NEXT_PUBLIC_WIKI_MIRROR_HEALTH_URL ?? "http://127.0.0.1:4440",
    pageTypes,
    build:
      commit !== undefined && branch !== undefined
        ? { branch, commit, time: process.env.NEXT_PUBLIC_BUILD_TIME ?? "" }
        : null,
  };
}
