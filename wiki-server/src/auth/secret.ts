/**
 * The session-signing secret, when the operator doesn't supply one: generated
 * once and persisted at `<dataDir>/auth/session-secret` (mode 0600) so sessions
 * survive restarts. Deleting the file (or setting `WIKI_SERVER_SESSION_SECRET`)
 * rotates it — which signs every user out, the whole revocation story for
 * stateless tokens.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fresh, never-persisted secret — the `storage=memory` pairing: sessions die
 * with the process, exactly like the streams they authorize.
 */
export function ephemeralSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

export function ensureSessionSecret(authDir: string): string {
  const path = join(authDir, "session-secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* fall through to generate */
  }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(path, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  return secret;
}
