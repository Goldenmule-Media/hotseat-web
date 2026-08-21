"use client";

/**
 * Typewriter-mode preference for the note editors — one setting for this browser, not one
 * per workspace or page: it is how the person writes, not something about the notes.
 * Default OFF, and hydrated in an effect so the first client render matches the
 * server-rendered markup (as with the other view-state hooks).
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "wiki-ui:typewriter";

export interface Typewriter {
  readonly on: boolean;
  toggle: () => void;
}

export function useTypewriter(): Typewriter {
  const [on, setOn] = useState(false);

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(KEY) === "1");
    } catch {
      setOn(false);
    }
  }, []);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Non-essential view state — ignore.
      }
      return next;
    });
  }, []);

  return { on, toggle };
}
