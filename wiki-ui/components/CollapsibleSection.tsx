"use client";

/**
 * A collapsible panel for the splash docs. Default expanded; the collapse state persists per
 * `storageKey` (see lib/useCollapsedDoc). Reuses the sidebar's disclosure pattern — a header
 * button carrying `aria-expanded` with a rotating caret.
 */
import type { ReactNode } from "react";
import { useCollapsedDoc } from "../lib/useCollapsedDoc";

export function CollapsibleSection({
  storageKey,
  title,
  children,
}: {
  storageKey: string;
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  const { collapsed, toggle } = useCollapsedDoc(storageKey);
  return (
    <section className="doc-section">
      <button type="button" className="doc-section-head" aria-expanded={!collapsed} onClick={toggle}>
        <span className={`caret${collapsed ? "" : " open"}`} aria-hidden="true">
          ▶
        </span>
        {title}
      </button>
      {!collapsed && <div className="doc-section-body">{children}</div>}
    </section>
  );
}
