"use client";

/**
 * A field the user is editing, staged over the engine's own text: `value` is the draft
 * while one is open and the engine's text otherwise.
 *
 * The point is WHEN a draft is retired. A write RESOLVES before the tail carries it back
 * and the read-back re-renders, so a draft dropped at resolution leaves the field showing
 * the PREVIOUS revision for that gap — the edit visibly reverts. Worse in a CodeMirror
 * field: re-seeding the document is indistinguishable from typing, so the stale text comes
 * straight back out through `onChange` and is saved over the new one. So the draft is
 * retired only once the engine's own text has ARRIVED ({@link StagedText.saved}), or right
 * away when there was nothing to write ({@link StagedText.drop}).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface StagedText {
  /** What the field shows: the open draft, or the engine's text when none is open. */
  readonly value: string;
  /** The open draft, or `null` when the field is showing the engine's text. */
  readonly draft: string | null;
  /** The user typed. */
  edit: (text: string) => void;
  /** A write of `text` committed — retire the draft when the engine's text arrives. */
  saved: (text: string) => void;
  /** Nothing was written (unchanged, abandoned, or rejected): drop the draft now. Pass the
   *  text that was considered, so a keystroke since then keeps its draft. */
  drop: (text?: string) => void;
}

export function useStagedText(stored: string): StagedText {
  const [draft, setDraft] = useState<string | null>(null);
  /** The saved text awaiting its read-back. */
  const landed = useRef<string | null>(null);
  const storedRef = useRef(stored);
  storedRef.current = stored;

  // `stored` changing IS the read-back: the engine has spoken since the write landed, so
  // whatever it now says outranks the draft (its text may be normalized, not byte-equal).
  useEffect(() => {
    const text = landed.current;
    if (text === null) return;
    landed.current = null;
    setDraft((d) => (d === text ? null : d));
  }, [stored]);

  const edit = useCallback((text: string) => setDraft(text), []);

  const saved = useCallback((text: string) => {
    // A write that changed nothing renders no new text to wait for.
    if (storedRef.current === text) setDraft((d) => (d === text ? null : d));
    else landed.current = text;
  }, []);

  const drop = useCallback((text?: string) => {
    setDraft((d) => (text === undefined || d === text ? null : d));
  }, []);

  return useMemo(() => ({ value: draft ?? stored, draft, edit, saved, drop }), [draft, stored, edit, saved, drop]);
}
