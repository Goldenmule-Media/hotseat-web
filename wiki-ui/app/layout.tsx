import type { Metadata } from "next";
import type { ReactNode } from "react";
import { HostGate } from "../components/HostGate";
import { SearchLauncher } from "../components/SearchLauncher";
import "./globals.css";

export const metadata: Metadata = {
  title: "wiki-ui",
  description: "Read-only, live-updating browser for a wiki-server.",
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        {/* Fail loudly on browsers without a module SharedWorker (no fallback, by decision). */}
        <HostGate>
          {children}
          {/* Global Ctrl/Cmd+K search palette — available on every route. */}
          <SearchLauncher />
        </HostGate>
      </body>
    </html>
  );
}
