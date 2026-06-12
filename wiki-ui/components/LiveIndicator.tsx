"use client";

/** Connection / live-update pulse (plan step 8). Reflects the session connection state
 *  and flashes briefly whenever a new event lands (`lastEventAt`). */
import { useEffect, useState } from "react";
import type { ConnectionState, LoadError } from "../lib/live";

const LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  error: "Disconnected",
};

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

  useEffect(() => {
    if (lastEventAt === null) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 700);
    return () => clearTimeout(t);
  }, [lastEventAt]);

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

  return (
    <span className="live-indicator" data-state={state} title={schemaError ? error.message : label}>
      <span className={`dot${pulse ? " pulse" : ""}`} />
      {label}
    </span>
  );
}
