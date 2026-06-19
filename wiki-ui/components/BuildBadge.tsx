"use client";

/**
 * Build provenance badge (sidebar foot). Shows the git branch + short commit this bundle
 * was built from — captured at build time by scripts/write-build-info.mjs and inlined via
 * NEXT_PUBLIC_*. This is how you confirm WHICH commit a deploy is actually serving. Links
 * to the commit on GitHub; renders nothing when the build carried no git info.
 */
import { getConfig } from "../lib/config";

const REPO_URL = "https://github.com/Goldenmule-Media/hotseat-web";

export function BuildBadge(): React.JSX.Element | null {
  const { build } = getConfig();
  if (build === null) return null;
  const short = build.commit.slice(0, 7);
  const title = `Built from ${build.branch}@${build.commit}${build.time ? ` on ${build.time}` : ""}`;
  return (
    <a
      className="build-badge"
      href={`${REPO_URL}/commit/${build.commit}`}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      <span className="build-branch">{build.branch}</span>
      <span className="build-commit">{short}</span>
    </a>
  );
}
