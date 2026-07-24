/** Pure state fold for the `useSectionElements` hook (lib/live.tsx) — kept out of the
 *  tsx module so it unit-tests without a JSX transform. */
import type { SectionElementSummary } from "./wiki-host-api";

export interface SectionElements {
  readonly elements: readonly SectionElementSummary[];
  readonly loading: boolean;
  /** Message of a failed (re-)read; `elements` then still holds the last good read. */
  readonly error: string | null;
}

export const ELEMENTS_PENDING: SectionElements = { elements: [], loading: true, error: null };

/** Fold one read outcome into the hook state: success replaces the elements; failure
 *  KEEPS the previous ones (a transient re-read error must not wipe a live view, or a
 *  consumer's selection with it). */
export function foldSectionElements(
  prev: SectionElements,
  outcome: { readonly elements: readonly SectionElementSummary[] } | { readonly error: string },
): SectionElements {
  return "elements" in outcome
    ? { elements: outcome.elements, loading: false, error: null }
    : { elements: prev.elements, loading: false, error: outcome.error };
}
