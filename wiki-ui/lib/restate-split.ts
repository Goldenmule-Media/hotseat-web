/**
 * The restate view's draggable spec/workbench split: the left column's fraction of the
 * studio width, clamped so BOTH columns keep a usable minimum, persisted globally (one
 * ratio for the app, not per page). Pure — the pointer wiring lives in the component.
 */
import type { KeyValueStore } from "./restate";

export const SPLIT_KEY = "wiki.restate.split";
export const DEFAULT_SPLIT = 0.55;
export const MIN_COLUMN_PX = 320;

/** Clamp a drag ratio so each column keeps {@link MIN_COLUMN_PX} of the container. A
 *  container too narrow for two minimums (the stacked layout owns that range anyway)
 *  falls back to an even split; a degenerate width falls back to the default. */
export function clampSplit(ratio: number, containerWidth: number, minPx: number = MIN_COLUMN_PX): number {
  if (!Number.isFinite(ratio) || !Number.isFinite(containerWidth) || containerWidth <= 0) return DEFAULT_SPLIT;
  const lo = minPx / containerWidth;
  const hi = 1 - lo;
  if (lo >= hi) return 0.5;
  return Math.min(hi, Math.max(lo, ratio));
}

/** The persisted ratio, or null when absent/unusable (callers keep the default). */
export function loadSplit(store: KeyValueStore): number | null {
  try {
    const raw = store.getItem(SPLIT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
  } catch {
    return null;
  }
}

export function saveSplit(store: KeyValueStore, ratio: number): void {
  try {
    store.setItem(SPLIT_KEY, String(ratio));
  } catch {
    // non-essential view state — ignore
  }
}
