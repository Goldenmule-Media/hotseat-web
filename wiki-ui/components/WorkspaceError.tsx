"use client";

/** Workspace-level failure surface. Renders a {@link LoadError} with a message tuned to
 *  its cause — most importantly, telling apart a server that's unreachable from one that's
 *  reachable but serving page types this build doesn't bundle (the failure that used to be
 *  mislabeled "Could not connect"). `compact` is the sidebar variant. */
import type { LoadError } from "../lib/live";

function describe(error: LoadError): { title: string; detail: string } {
  switch (error.kind) {
    case "unknown-page-type": {
      const types =
        error.unknownTypes.length > 0 ? error.unknownTypes.join(", ") : "one or more types";
      return {
        title: "Unsupported page types",
        detail:
          `This workspace uses page type(s) this build doesn't know: ${types}. ` +
          `Add the matching wiki-models bundle to wiki-ui/lib/models.ts and rebuild.`,
      };
    }
    case "engine":
      return { title: "Couldn't load workspace", detail: error.message };
    case "connection":
      return {
        title: "Disconnected",
        detail: "Can't reach the wiki-server. Retrying automatically…",
      };
    case "unsupported":
      return {
        title: "Unsupported browser",
        detail: "wiki-ui needs a module SharedWorker (Chrome/Edge, Firefox 114+, or Safari 16+).",
      };
  }
}

export function WorkspaceError({
  error,
  compact = false,
}: {
  error: LoadError;
  compact?: boolean;
}): React.JSX.Element {
  const { title, detail } = describe(error);
  if (compact) {
    return (
      <p className="muted error" title={detail}>
        {title}
      </p>
    );
  }
  return (
    <div className="notice error">
      <strong>{title}</strong>
      <p className="muted">{detail}</p>
    </div>
  );
}
