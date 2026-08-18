"use client";

/**
 * Renders an overlay into `document.body`.
 *
 * `.sidebar` is `position: sticky`, which establishes a stacking context — so a
 * `position: fixed` overlay declared inside it (the modals opened from the workspace title
 * row) is confined to that context and paints UNDER the main column whatever its z-index.
 * Portalling out of the sidebar is the fix; raising z-index cannot work from in there.
 *
 * The mounted guard keeps SSR honest: `document` doesn't exist during the server render, and
 * a modal is only ever opened by a client interaction anyway.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function ModalPortal({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <>{createPortal(children, document.body)}</>;
}
