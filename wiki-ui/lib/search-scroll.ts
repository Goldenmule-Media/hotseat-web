"use client";

/**
 * The "scroll to the matched text" half of search. When a result is chosen, the modal
 * parks a target here (which page, which terms to find) and navigates. The destination
 * {@link PageView} subscribes, and once its content is in the DOM it scrolls the first
 * matching text into view and flashes a highlight, then clears the target so it fires
 * once. A module-level store (not router state) because the target must survive the
 * route change and the modal unmounting — the same pattern the rest of the UI uses for
 * cross-navigation state (see lib/view-mode.ts).
 */
import { useSyncExternalStore } from "react";

export interface ScrollTarget {
  readonly workspaceId: string;
  readonly pageId: string;
  /** Candidate strings to locate in the rendered body, best-first (exact match terms
   *  from the snippet, then the raw query tokens). The first that occurs wins. */
  readonly terms: readonly string[];
}

let target: ScrollTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Park a scroll target for the page about to be navigated to. */
export function requestScrollTo(next: ScrollTarget): void {
  target = next;
  emit();
}

/** Clear the target (after a successful scroll, or when it no longer applies). */
export function clearScrollTarget(): void {
  if (target === null) return;
  target = null;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The current parked scroll target; re-renders subscribers when it changes. */
export function useScrollTarget(): ScrollTarget | null {
  return useSyncExternalStore(subscribe, () => target, () => null);
}

/**
 * Find the first occurrence of any `term` in `container`'s rendered text, scroll it into
 * view, and wrap it in a `<mark class="search-highlight">` that flashes then fades (CSS).
 * Terms are tried in order, so an exact snippet term is preferred over a looser query
 * token. Case-insensitive. Returns true if something was found and scrolled.
 */
export function scrollToTerms(container: HTMLElement, terms: readonly string[]): boolean {
  const candidates = terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 2);
  for (const term of candidates) {
    const found = findFirst(container, term);
    if (found === null) continue;
    const { node, index } = found;
    const range = container.ownerDocument.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + term.length);
    const mark = container.ownerDocument.createElement("mark");
    mark.className = "search-highlight";
    try {
      range.surroundContents(mark);
    } catch {
      // surroundContents throws if the range partially selects a non-text node; the range
      // is always within one text node here, but fall back to a plain scroll just in case.
      node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }
  return false;
}

/** Walk text nodes in document order; return the first node + offset containing `term`. */
function findFirst(container: HTMLElement, term: string): { node: Text; index: number } | null {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    const index = node.data.toLowerCase().indexOf(term);
    if (index !== -1) return { node, index };
    node = walker.nextNode() as Text | null;
  }
  return null;
}
