import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthGate } from "../components/AuthGate";
import { HostGate } from "../components/HostGate";
import { SearchLauncher } from "../components/SearchLauncher";
import { AuthProvider } from "../lib/auth-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hotseat Wiki",
  description: "Read-only, live-updating browser for a wiki-server.",
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        {/* Fail loudly on browsers without a module SharedWorker (no fallback, by decision). */}
        <HostGate>
          {/* When the server's auth gateway is on, gate the whole app (and the worker
              connection) behind GitHub sign-in; when it's off, render as before. */}
          <AuthProvider>
            <AuthGate>
              {children}
              {/* Global Ctrl/Cmd+K search palette — available on every route. */}
              <SearchLauncher />
            </AuthGate>
          </AuthProvider>
        </HostGate>
      </body>
    </html>
  );
}
