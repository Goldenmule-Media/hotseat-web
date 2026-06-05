/**
 * Engine bootstrap (plan step 3). A single browser-side `IWiki` per tab, created from
 * the configured stream + page types. The engine consumes the Durable Stream directly
 * via @durable-streams/client (Q3) — no MCP, no server-side fold.
 *
 * Returns `null` on the server: client components still pre-render on the server in
 * Next, and we must NOT open a stream there. Callers treat `null` as "not ready yet"
 * and instantiate the real engine inside an effect (client only).
 */
import { createWiki, type IWiki } from "wiki";
import { getConfig } from "./config";
import { getSearchDb } from "./search-db";

let singleton: IWiki | undefined;

export function getWiki(): IWiki | null {
  if (typeof window === "undefined") return null;
  if (singleton === undefined) {
    const cfg = getConfig();
    singleton = createWiki({
      stream: { baseUrl: cfg.streamBaseUrl, namespace: cfg.namespace },
      pageTypes: cfg.pageTypes,
      // Run the engine's full-text search index in the browser, persisted to IndexedDB
      // via PGlite. With this wired, opening a workspace folds AND indexes it, and
      // `wiki.search` / `handle.search` return real ranked hits (see lib/search-db.ts).
      search: { db: getSearchDb() },
    });
  }
  return singleton;
}
