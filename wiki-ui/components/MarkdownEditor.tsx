"use client";

/**
 * The live markdown editor (feature: study-notes studio): a CodeMirror 6 view wired for
 * Obsidian-style live preview (lib/md-live.ts). Uncontrolled while focused — the user's
 * keystrokes own the document and flow out through `onChange`; an external `value`
 * change (another client's commit arriving over the live tail) replaces the document
 * only while the editor is NOT focused, so a sync can never fight the cursor.
 */
import { useEffect, useRef } from "react";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { imageUploadExtension, liveEditorBase, liveEditorTermsExtension, type EditorTermRef } from "../lib/md-live";

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  terms,
  onTermClick,
  placeholder,
  autoFocus,
  submitOnEnter,
  onUploadImage,
}: {
  value: string;
  onChange: (text: string) => void;
  /** Focus left the editor — the caller's moment to commit (e.g. save-on-blur). */
  onBlur?: () => void;
  terms: readonly EditorTermRef[];
  onTermClick: (termId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Enter blurs the editor (firing `onBlur` — i.e. submit); Shift-Enter still breaks a
   *  line. For short single-thought fields like a glossary definition. */
  submitOnEnter?: boolean;
  /** Upload a pasted or dropped image and return its `attachment:<sha>` ref. Omitted =
   *  the editor takes no files, and a paste falls through to CodeMirror's default. */
  onUploadImage?: (file: File) => Promise<string>;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const termsComp = useRef(new Compartment());
  // The latest callbacks, readable from stable CM closures.
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onTermClickRef = useRef(onTermClick);
  const onUploadImageRef = useRef(onUploadImage);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;
  onTermClickRef.current = onTermClick;
  onUploadImageRef.current = onUploadImage;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      doc: value,
      extensions: [
        ...(submitOnEnter === true
          ? [
              Prec.highest(
                keymap.of([
                  {
                    key: "Enter",
                    run: (v) => {
                      v.contentDOM.blur();
                      return true;
                    },
                  },
                ]),
              ),
            ]
          : []),
        liveEditorBase(placeholder),
        // Reads the ref, so an editor mounted before its uploader is ready still works —
        // and one with no uploader lets the paste fall through untouched.
        imageUploadExtension(() => onUploadImageRef.current),
        termsComp.current.of(liveEditorTermsExtension({ terms, onTermClick: (id) => onTermClickRef.current(id) })),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.focusChanged && !u.view.hasFocus) onBlurRef.current?.();
        }),
      ],
    });
    viewRef.current = view;
    if (autoFocus === true) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Mount-once: value/terms updates flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External content sync — only while unfocused (see file header).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || view.hasFocus) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // The glossary changed: swap the term-highlight extension in place.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: termsComp.current.reconfigure(
        liveEditorTermsExtension({ terms, onTermClick: (id) => onTermClickRef.current(id) }),
      ),
    });
  }, [terms]);

  return <div ref={hostRef} className="study-cm" />;
}
