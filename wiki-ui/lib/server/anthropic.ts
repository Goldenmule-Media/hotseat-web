/**
 * Server-only Anthropic client, kept apart from the chat itself so the health route can
 * answer "is this configured?" without importing prompts, validators, or the `claude` CLI.
 *
 * The key is an ordinary server environment variable and never a NEXT_PUBLIC_ one. It is read
 * from process.env inside lib/server/ and cannot reach the browser bundle. Next does not read
 * the repo root .env, so wiki-ui needs its own copy of the line: wiki-ui/.env.local locally, a
 * platform environment variable on Amplify.
 */
import Anthropic from "@anthropic-ai/sdk";

export const CHAT_MODEL = "claude-opus-5";

export interface Availability {
  available: boolean;
  reason?: string;
}

/** Pure over an env record. Configured means a non-empty key, nothing more. */
export function decideAnthropicAvailability(env: Record<string, string | undefined>): Availability {
  const key = env.ANTHROPIC_API_KEY;
  if (key === undefined || key.trim() === "") {
    return { available: false, reason: "ANTHROPIC_API_KEY is not set (see wiki-ui/.env.example)" };
  }
  return { available: true };
}

let client: Anthropic | null = null;

/**
 * The shared client, or `null` when there is no key. The check happens before construction so
 * that an unconfigured server answers with our sentence rather than an SDK constructor throw.
 */
export function anthropicClient(): Anthropic | null {
  if (!decideAnthropicAvailability(process.env).available) return null;
  // The SDK retries timeouts as well as 429/5xx, and the wall clock is timeout × (retries + 1).
  // Someone is watching a spinner, so one retry is the whole budget. No client-level `timeout`:
  // that is a per-request option, which keeps WIKI_UI_CHAT_TIMEOUT_MS authoritative.
  client ??= new Anthropic({ maxRetries: 1 });
  return client;
}

/** Most specific first. APIConnectionTimeoutError extends APIConnectionError, so the order of
 *  these two is load-bearing. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "was cancelled";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timed out";
  if (err instanceof Anthropic.AuthenticationError) return "was refused: the API key is not valid";
  if (err instanceof Anthropic.RateLimitError) return "is rate limited — try again in a moment";
  if (err instanceof Anthropic.APIConnectionError) return "could not reach the API";
  if (err instanceof Anthropic.APIError) return `failed (HTTP ${err.status})`;
  return "failed";
}
