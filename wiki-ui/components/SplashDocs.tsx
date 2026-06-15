"use client";

/**
 * Baked-in onboarding docs for the landing page: what the app is, and how to point an LLM client
 * at it. Each section is collapsible and remembers a collapse in localStorage (default expanded).
 */
import { useState } from "react";
import { mcpEndpointUrl } from "../lib/auth";
import { CollapsibleSection } from "./CollapsibleSection";

export function SplashDocs(): React.JSX.Element {
  const installCommand = `claude mcp add --transport http hotseat ${mcpEndpointUrl()}`;

  return (
    <div className="splash-docs">
      <CollapsibleSection storageKey="what-is-this" title="What is this?">
        <p>
          Hotseat Wiki is an <strong>LLM-first, event-sourced structured wiki</strong>. Pages are typed
          documents — not free text — that change only through named, typed, FSM-gated{" "}
          <strong>mutations</strong>. Each page type declares a small workflow (a status machine plus the
          commands that drive it), so the wiki itself encodes what should happen next.
        </p>
        <p>
          That makes it a natural home for <strong>agents</strong>: an LLM reads a page&apos;s available
          actions, drives the workflow forward to completion, and stops at the points a human needs to
          decide. Everything renders deterministically to Markdown, and every change streams to this
          browser live.
        </p>
        <p className="muted">
          This browser is read-first: it shows workspaces live and lets you drive a page&apos;s workflow
          transitions. The authoring happens through the MCP server below.
        </p>
      </CollapsibleSection>

      <CollapsibleSection storageKey="quick-start" title="Quick start">
        <ol className="doc-steps">
          <li>
            Install <strong>Claude Code</strong> (or any MCP-capable client).
          </li>
          <li>
            Add this server as an MCP endpoint:
            <CopyCommand command={installCommand} />
            <span className="muted">
              Claude Code signs in through the server&apos;s OAuth flow on first use — no token to paste.
            </span>
          </li>
          <li>
            Ask Claude to <strong>create or open a workspace</strong>, then drive a page&apos;s workflow.
            Edits show up here instantly.
          </li>
        </ol>
      </CollapsibleSection>
    </div>
  );
}

/** A mono command with a copy button — reuses the clipboard + transient-✓ pattern from AccountMenu. */
function CopyCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-copy">
      <code>{command}</code>
      <button
        type="button"
        className="icon-btn"
        title="Copy command"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
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
