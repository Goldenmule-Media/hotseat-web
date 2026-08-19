"use client";

/**
 * Obsidian-style LIVE-PREVIEW extensions for CodeMirror 6 (feature: study-notes studio).
 * The document is markdown source, but it READS as rendered markdown: headings are
 * sized, bold is bold, bullets draw as •, and the formatting characters themselves
 * (`**`, `#`, `` ` ``, link brackets) are hidden — except inside the construct the
 * cursor is currently touching, which reveals its raw source for editing. Exactly the
 * "edit the immediate context as markdown source" model.
 *
 * Two decoration plugins:
 *  - {@link livePreview}: walks the visible syntax tree; formatting-mark nodes are
 *    replaced (hidden) unless a selection range touches their enclosing construct;
 *    inactive bullet-list markers render as a • widget.
 *  - {@link termHighlight}: underlines glossary-term occurrences by status (same
 *    classes as the rendered view); mod-click on one reports the term id.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree, HighlightStyle } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { SyntaxNodeRef } from "@lezer/common";
import { findTermMatches } from "./study";

// ── typography: the source styled as its rendered self ──────────────────────────

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "650" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "650" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "650" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "650" },
  { tag: tags.heading5, fontWeight: "650" },
  { tag: tags.heading6, fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: "0.9em" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.quote, color: "var(--muted)" },
  { tag: [tags.processingInstruction, tags.meta], color: "var(--muted)" },
]);

// ── live preview: hide formatting marks outside the cursor's construct ──────────

/** The formatting-mark node names to hide, each revealed while the cursor touches the
 *  named enclosing construct(s). */
const MARK_PARENTS: Readonly<Record<string, readonly string[]>> = {
  HeaderMark: ["ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6"],
  EmphasisMark: ["Emphasis", "StrongEmphasis"],
  CodeMark: ["InlineCode"],
  StrikethroughMark: ["Strikethrough"],
  LinkMark: ["Link", "Image"],
  URL: ["Link", "Image"],
};

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  override eq(): boolean {
    return true;
  }
}

const BULLET = new BulletWidget();

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.to >= from && r.from <= to);
}

/** The enclosing construct a mark belongs to, or null (then the mark stays visible). */
function constructOf(node: SyntaxNodeRef, parents: readonly string[]): { from: number; to: number } | null {
  for (let p = node.node.parent; p !== null; p = p.parent) {
    if (parents.includes(p.name)) return { from: p.from, to: p.to };
  }
  return null;
}

function buildLiveDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;
  const doc = state.doc;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const parents = MARK_PARENTS[node.name];
        if (parents !== undefined) {
          const ctx = constructOf(node, parents);
          if (ctx === null || selectionTouches(state, ctx.from, ctx.to)) return;
          let hideTo = node.to;
          // A header mark owns its following space, so `## Title` renders flush.
          if (node.name === "HeaderMark" && hideTo < doc.length && doc.sliceString(hideTo, hideTo + 1) === " ") hideTo += 1;
          if (hideTo > node.from) decos.push(Decoration.replace({}).range(node.from, hideTo));
          return;
        }
        if (node.name === "ListMark") {
          // Bullets render as •; ordered-list numbers stay. The raw mark returns while
          // the cursor is on its line.
          const text = doc.sliceString(node.from, node.to);
          if (!/^[-*+]$/.test(text)) return;
          const line = doc.lineAt(node.from);
          if (selectionTouches(state, line.from, line.to)) return;
          decos.push(Decoration.replace({ widget: BULLET }).range(node.from, node.to));
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLiveDecorations(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = buildLiveDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ── glossary-term underlines inside the editor ──────────────────────────────────

export interface EditorTermRef {
  readonly id: string;
  readonly term: string;
  readonly status: string;
}

function buildTermDecorations(view: EditorView, terms: readonly EditorTermRef[]): DecorationSet {
  if (terms.length === 0) return Decoration.none;
  const byId = new Map(terms.map((t) => [t.id, t]));
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of findTermMatches(text, terms)) {
      const t = byId.get(m.termId)!;
      decos.push(
        Decoration.mark({
          class: `study-term study-term-${t.status}`,
          attributes: { "data-term-id": t.id, title: `${t.term} — ${t.status} (⌘-click to open)` },
        }).range(from + m.start, from + m.end),
      );
    }
  }
  return Decoration.set(decos, true);
}

function termHighlight(terms: readonly EditorTermRef[], onTermClick: (termId: string) => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildTermDecorations(view, terms);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = buildTermDecorations(u.view, terms);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const clicks = EditorView.domEventHandlers({
    mousedown: (e) => {
      if (!e.metaKey && !e.ctrlKey) return false;
      const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-term-id]");
      if (hit?.dataset.termId === undefined) return false;
      onTermClick(hit.dataset.termId);
      e.preventDefault();
      return true;
    },
  });
  return [plugin, clicks];
}

// ── the editor theme (blends into the card; the page scrolls, never the editor) ──

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "inherit",
    caretColor: "var(--text)",
    padding: "0",
    lineHeight: "1.55",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground": { backgroundColor: "var(--accent-dim) !important" },
  ".cm-md-bullet": { color: "var(--muted)" },
  ".cm-placeholder": { color: "var(--muted)" },
});

// ── assembly ────────────────────────────────────────────────────────────────────

export interface LiveEditorConfig {
  readonly terms: readonly EditorTermRef[];
  readonly onTermClick: (termId: string) => void;
  readonly placeholder?: string;
}

/** The reconfigurable slice of the setup — swapped when the glossary changes. */
export function liveEditorTermsExtension(config: LiveEditorConfig): Extension {
  return termHighlight(config.terms, config.onTermClick);
}

/**
 * Paste or drop an image file to upload it and get a Markdown image back.
 *
 * A placeholder goes in immediately and is replaced when the upload resolves, so a slow
 * network never blocks typing. The placeholder is matched by TEXT rather than by a
 * remembered position, because the document may have been edited while the bytes were in
 * flight and a stale offset would splice the ref into the middle of a word.
 */
export function imageUploadExtension(
  /** Read per event so an editor mounted before its uploader exists still picks it up;
   *  `undefined` means this editor takes no files and the paste falls through. */
  uploader: () => ((file: File) => Promise<string>) | undefined,
): Extension {
  let seq = 0;

  const insert = (view: EditorView, files: readonly File[]): boolean => {
    const upload = uploader();
    if (upload === undefined) return false;
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    for (const file of images) {
      const token = `![uploading ${file.name}… #${++seq}]()`;
      const at = view.state.selection.main;
      view.dispatch({
        changes: { from: at.from, to: at.to, insert: token },
        selection: { anchor: at.from + token.length },
      });
      void upload(file)
        .then((ref) => `![${file.name.replace(/\.[^.]+$/, "")}](${ref})`)
        .catch(() => `![${file.name} — upload failed]()`)
        .then((replacement) => {
          const idx = view.state.doc.toString().indexOf(token);
          if (idx === -1) return; // the user deleted the placeholder; nothing to replace
          view.dispatch({ changes: { from: idx, to: idx + token.length, insert: replacement } });
        });
    }
    return true;
  };

  return EditorView.domEventHandlers({
    paste: (e, view) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!insert(view, files)) return false;
      e.preventDefault();
      return true;
    },
    drop: (e, view) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!insert(view, files)) return false;
      e.preventDefault();
      return true;
    },
    dragover: (e) => {
      // Without this the browser navigates to the dropped file instead of firing `drop`.
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
        e.preventDefault();
        return true;
      }
      return false;
    },
  });
}

/** The stable extension set for one live markdown editor. */
export function liveEditorBase(placeholderText?: string): Extension {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    livePreview,
    editorTheme,
    EditorView.lineWrapping,
    ...(placeholderText !== undefined ? [placeholder(placeholderText)] : []),
  ];
}
