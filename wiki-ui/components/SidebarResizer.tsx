"use client";

/** Draggable divider on the sidebar/content boundary. Drives the `--sidebar-width`
 *  CSS var on the `.shell` grid and persists the chosen width to localStorage. */
import { useEffect, useRef } from "react";

const MIN = 200;
const MAX = 560;
const KEY = "wiki-ui:sidebar-width";

function clamp(width: number): number {
  return Math.max(MIN, Math.min(MAX, width));
}

export function SidebarResizer(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Apply the stored width after mount only — setting it during SSR would mismatch.
  useEffect(() => {
    const shell = ref.current?.closest(".shell") as HTMLElement | null;
    const stored = Number(localStorage.getItem(KEY));
    if (shell && Number.isFinite(stored) && stored > 0) {
      shell.style.setProperty("--sidebar-width", `${clamp(stored)}px`);
    }
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const handle = ref.current;
    const shell = handle?.closest(".shell") as HTMLElement | null;
    if (!handle || !shell) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    const originLeft = shell.getBoundingClientRect().left;

    const apply = (clientX: number): number => {
      const width = clamp(clientX - originLeft);
      shell.style.setProperty("--sidebar-width", `${width}px`);
      return width;
    };
    const onMove = (ev: PointerEvent): void => {
      apply(ev.clientX);
    };
    const onUp = (ev: PointerEvent): void => {
      handle.classList.remove("is-dragging");
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      localStorage.setItem(KEY, String(apply(ev.clientX)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={ref}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
    />
  );
}
