/**
 * Dev-only testing helpers.
 *
 * Promotes the real (in-memory) `DurableStreamTestServer` into a one-liner test
 * harness: `startTestServer()` boots a fresh server on an ephemeral port, and
 * `createTestWiki(pageTypes)` wires a {@link createWiki} to it with DETERMINISTIC
 * default `clock` + `ids` so event metadata and generated ids are byte-stable
 * across runs. `wikiOn(url, …)` attaches a SECOND wiki to an already-running
 * server (same namespace) for the concurrency test.
 *
 * Host clock / entropy never enter the engine here: the injected `clock`/`ids`
 * are pure counters, so reducers/deciders/renderers stay deterministic. The only
 * non-determinism is the server's port, which is irrelevant to engine output.
 */
import { DurableStreamTestServer } from "@durable-streams/server";

import type { IPageType, IStreamHeaders, IWiki } from "./api";
import { createWiki } from "./core/wiki";

/** Injected determinism knobs shared by the test-wiki factories. */
export interface ITestWikiOptions {
  /** Override the deterministic ISO-8601 clock. */
  readonly clock?: () => string;
  /** Override the deterministic id generator. */
  readonly ids?: () => string;
  /** Namespace segment for the wiki's streams. @default "test" */
  readonly namespace?: string;
  /** Default actor stamped on event metadata. */
  readonly actor?: string;
  /** Headers on every stream request (e.g. a bearer token against an auth-gated host). */
  readonly headers?: IStreamHeaders;
}

/** A started in-memory test server plus its base URL and a teardown. */
export interface ITestServer {
  /** Base URL the server is listening on, e.g. "http://127.0.0.1:53124". */
  readonly url: string;
  /** The underlying server instance (for `clear()`, fault injection, etc.). */
  readonly server: DurableStreamTestServer;
  /** Stop the server. */
  stop(): Promise<void>;
}

/** A test wiki plus the server it is bound to and a single combined teardown. */
export interface ITestWiki extends ITestServer {
  /** The wiki bound to {@link ITestServer.url}. */
  readonly wiki: IWiki;
}

/** Base epoch for the deterministic clock: 2020-01-01T00:00:00.000Z. */
const CLOCK_EPOCH_MS = Date.UTC(2020, 0, 1, 0, 0, 0, 0);

/**
 * Deterministic ISO-8601 clock: each call advances by one second starting at
 * 2020-01-01T00:00:00.000Z (`…T00:00:01.000Z`, `…T00:00:02.000Z`, …).
 */
function deterministicClock(): () => string {
  let counter = 0;
  return () => {
    const iso = new Date(CLOCK_EPOCH_MS + counter * 1000).toISOString();
    counter += 1;
    return iso;
  };
}

/**
 * Deterministic id generator: `id-1`, `id-2`, `id-3`, … Prefix-counter form so
 * generated workspace/page/item/event ids are stable and human-readable in tests.
 */
function deterministicIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

/**
 * Start a fresh in-memory {@link DurableStreamTestServer} on an ephemeral port.
 * Resolves once the server is listening.
 */
export async function startTestServer(): Promise<ITestServer> {
  const server = new DurableStreamTestServer({ port: 0 });
  const url = await server.start();
  return {
    url,
    server,
    stop: () => server.stop(),
  };
}

/**
 * Build an {@link IWiki} bound to an already-running server `url`, using the
 * deterministic default `clock`/`ids` unless overridden in `opts`.
 */
export function wikiOn(
  url: string,
  pageTypes: readonly IPageType[],
  opts?: ITestWikiOptions,
): IWiki {
  return createWiki({
    stream: {
      baseUrl: url,
      namespace: opts?.namespace ?? "test",
      ...(opts?.headers !== undefined ? { headers: opts.headers } : {}),
    },
    pageTypes,
    clock: opts?.clock ?? deterministicClock(),
    ids: opts?.ids ?? deterministicIds(),
    ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
  });
}

/**
 * Start a test server AND a wiki bound to it, with deterministic injected
 * `clock`/`ids` by default. Returns the wiki, the server, its url, and a single
 * `stop()` that tears both down.
 */
export async function createTestWiki(
  pageTypes: readonly IPageType[],
  opts?: ITestWikiOptions,
): Promise<ITestWiki> {
  const { url, server } = await startTestServer();
  const wiki = wikiOn(url, pageTypes, opts);
  return {
    wiki,
    server,
    url,
    stop: async () => {
      await wiki.close();
      await server.stop();
    },
  };
}
