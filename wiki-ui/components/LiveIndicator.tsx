"use client";

/** Connection / live-update pulse (plan step 8). Reflects the session connection state
 *  and flashes briefly whenever a new event lands (`lastEventAt`).
 *
 *  It is also the handle on the ENGINE itself: the tail, the fold and the search index all
 *  live in one SharedWorker shared by every tab, so when this says something other than
 *  "Live" — or when a rebuild has left the worker running yesterday's code — the remedy is
 *  to close that worker and let the next load start a fresh one. Clicking opens a small
 *  panel that does exactly that, without a trip to chrome://inspect#workers. */
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, LoadError } from "../lib/live";
import { getHost } from "../lib/host-client";

const LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  error: "Disconnected",
};

/** How long to let the worker's teardown run before this tab reloads into a fresh one. */
const RESTART_RELOAD_MS = 400;

export function LiveIndicator({
  connection,
  lastEventAt,
  error = null,
}: {
  connection: ConnectionState;
  lastEventAt: number | null;
  error?: LoadError | null;
}): React.JSX.Element {
  const [pulse, setPulse] = useState(false);
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastEventAt === null) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 700);
    return () => clearTimeout(t);
  }, [lastEventAt]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A schema/engine error means the server is reachable but unrenderable — don't claim
  // "Live", and don't claim "Disconnected" either. Connection-kind errors fall through
  // to the transport label (e.g. "Disconnected"/"Reconnecting…"). An auth rejection is
  // labelled honestly for the moment before the gate falls back to the login page; a
  // membership rejection ("forbidden") is a valid session without access — "No access".
  const schemaError = error !== null && error.kind !== "connection";
  const state = schemaError ? "schema" : connection;
  const label = schemaError
    ? error.kind === "unauthorized"
      ? "Signed out"
      : error.kind === "forbidden"
        ? "No access"
        : "Schema error"
    : LABEL[connection];

  const restart = async (): Promise<void> => {
    setRestarting(true);
    try {
      (await getHost()).restart();
    } catch {
      // Never connected (or an unsupported browser): the reload is the whole remedy.
    }
    window.setTimeout(() => window.location.reload(), RESTART_RELOAD_MS);
  };

  return (
    <div className="live-wrap" ref={wrapRef}>
      <button
        type="button"
        className="live-indicator"
        data-state={state}
        title={schemaError ? error.message : label}
        aria-expanded={open}
        aria-label={`Engine: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dot${pulse ? " pulse" : ""}`} />
        {label}
      </button>
      {open && (
        <div className="live-panel" role="dialog" aria-label="Engine">
          <div className="live-panel-row">
            <span className="live-panel-key">Status</span>
            <span data-state={state} className="live-panel-state">
              {label}
            </span>
          </div>
          <div className="live-panel-row">
            <span className="live-panel-key">Last commit</span>
            <span>{lastEventAt === null ? "—" : new Date(lastEventAt).toLocaleTimeString()}</span>
          </div>
          {error !== null && <p className="live-panel-error">{error.message}</p>}
          <p className="live-panel-note">
            The engine runs in one SharedWorker shared by every tab. Restarting closes it and
            reloads this tab; other open tabs need a reload too.
          </p>
          <button type="button" className="live-panel-btn" disabled={restarting} onClick={() => void restart()}>
            {restarting ? "Restarting…" : "Restart engine"}
          </button>
        </div>
      )}
    </div>
  );
}
