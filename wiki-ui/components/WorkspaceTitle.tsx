"use client";

/** Sidebar workspace title: the current workspace's name plus a copy-id button. */
import { useState } from "react";
import type { WorkspaceId } from "wiki";
import { useWorkspaces } from "../lib/live";

export function WorkspaceTitle({ id }: { id: WorkspaceId }): React.JSX.Element {
  const { items } = useWorkspaces();
  const name = items.find((w) => w.id === id)?.name ?? id;
  const [copied, setCopied] = useState(false);

  return (
    <div className="ws-title">
      <span className="ws-name" title={id}>
        {name}
      </span>
      <button
        className="icon-btn"
        title="Copy workspace id"
        aria-label="Copy workspace id"
        onClick={() => {
          void navigator.clipboard.writeText(id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </div>
  );
}
