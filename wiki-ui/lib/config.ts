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
  /** Page types the UI can render — resolved from configured model bundles at build time. */
  readonly pageTypes: readonly IPageType[];
}

export function getConfig(): WikiUiConfig {
  return {
    streamBaseUrl: process.env.NEXT_PUBLIC_WIKI_STREAM_BASE_URL ?? "http://127.0.0.1:4437",
    namespace: process.env.NEXT_PUBLIC_WIKI_NAMESPACE ?? "default",
    pageTypes,
  };
}
