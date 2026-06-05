import type { Metadata } from "next";
import type { ReactNode } from "react";
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
        {children}
        {/* Global Ctrl/Cmd+K search palette — available on every route. */}
        <SearchLauncher />
      </body>
    </html>
  );
}
