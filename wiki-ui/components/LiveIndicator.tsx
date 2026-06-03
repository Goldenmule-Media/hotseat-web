"use client";

/** Connection / live-update pulse (plan step 8). Reflects the session connection state
 *  and flashes briefly whenever a new event lands (`lastEventAt`). */
import { useEffect, useState } from "react";
import type { ConnectionState } from "../lib/live";

const LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  error: "Disconnected",
};

export function LiveIndicator({
  connection,
  lastEventAt,
}: {
  connection: ConnectionState;
  lastEventAt: number | null;
}): React.JSX.Element {
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (lastEventAt === null) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 700);
    return () => clearTimeout(t);
  }, [lastEventAt]);

  return (
    <span className="live-indicator" data-state={connection} title={LABEL[connection]}>
      <span className={`dot${pulse ? " pulse" : ""}`} />
      {LABEL[connection]}
    </span>
  );
}
