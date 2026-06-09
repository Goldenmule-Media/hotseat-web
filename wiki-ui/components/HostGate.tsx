"use client";

/**
 * App-wide feature-detect gate. Renders the normal app, except on a browser without
 * SharedWorker — there it shows {@link UnsupportedBrowser} instead of letting every workspace
 * surface its own connection-shaped failure.
 *
 * It renders children during SSR and the first client paint (`supported === null`) so there is
 * no hydration mismatch / flash; only after mount does it switch to the unsupported message if
 * the capability is absent. The detection is cheap and constructs no worker.
 */
import { useEffect, useState, type ReactNode } from "react";
import { isHostSupported } from "../lib/host-client";
import { UnsupportedBrowser } from "./UnsupportedBrowser";

export function HostGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(isHostSupported());
  }, []);

  if (supported === false) return <UnsupportedBrowser />;
  return <>{children}</>;
}
