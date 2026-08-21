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
 *    inactive bullet-list markers render as a • widget; nested list lines are indented
 *    by their nesting depth.
 *  - {@link termHighlight}: underlines glossary-term occurrences by status (same
 *    classes as the rendered view); mod-click on one reports the term id.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree, HighlightStyle } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
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

/**
 * A nested list's only indentation in the source is two spaces per level, which in a
 * proportional font is a few pixels — invisible. Each level past the first gets a real
 * pad, so depth reads at a glance and wrapped lines hang under their own bullet.
 */
const INDENT_STEP_EM = 1.5;
const MAX_INDENT_LEVELS = 8;

const indentLine: Decoration[] = [];
function indentDecoration(level: number): Decoration {
  const cached = indentLine[level];
  if (cached !== undefined) return cached;
  const deco = Decoration.line({ attributes: { style: `padding-left:${level * INDENT_STEP_EM}em` } });
  indentLine[level] = deco;
  return deco;
}

/** How many lists enclose this position: 0 = not in a list, 1 = a top-level item. */
function listDepthAt(state: EditorState, pos: number): number {
  let depth = 0;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n !== null; n = n.parent) {
    if (n.name === "BulletList" || n.name === "OrderedList") depth++;
  }
  return depth;
}

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
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const textStart = line.from + (line.text.length - line.text.trimStart().length);
      const depth = Math.min(listDepthAt(state, textStart), MAX_INDENT_LEVELS);
      if (depth > 1) decos.push(indentDecoration(depth - 1).range(line.from));
      pos = line.to + 1;
    }
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

// ── typewriter scrolling ────────────────────────────────────────────────────────

/** A scroller that CLIPS has a height of its own; one that doesn't IS its content. */
function clips(scroller: HTMLElement): boolean {
  return window.getComputedStyle(scroller).overflowY !== "visible";
}

/**
 * Keep the caret on the middle line and move the text under it, the way a typewriter's
 * carriage stays put while the paper travels: a new line pushes what came before it up
 * rather than marching the cursor toward the bottom edge.
 *
 * It takes two pieces. Half an editor of padding at each end is what lets the FIRST and
 * LAST lines reach the middle at all (measured, not a guess, so there is no dead space
 * beyond the end), and a re-centre on every edit or cursor move keeps them there. Only
 * while focused — an external commit arriving over the tail must never yank the view.
 *
 * Both pieces need a box that CLIPS. Where the editor grows with its text instead and the
 * page does the scrolling, padding would feed its own measurement, so both stand down and
 * the layout is expected to give the editor a window (globals.css, `.is-typewriter`).
 */
function typewriterPadding(): Extension {
  return ViewPlugin.fromClass(
    class {
      private pad = -1;
      constructor(private readonly view: EditorView) {
        this.measure();
      }
      update(u: ViewUpdate): void {
        if (u.geometryChanged) this.measure();
      }
      measure(): void {
        this.view.requestMeasure({
          read: (v) => (clips(v.scrollDOM) ? v.scrollDOM.clientHeight : 0),
          write: (height, v) => {
            const pad = height === 0 ? 0 : Math.max(0, Math.round(height / 2 - 16));
            if (pad === this.pad) return; // writing it back would re-trigger the measure
            this.pad = pad;
            v.contentDOM.style.paddingTop = pad === 0 ? "" : `${pad}px`;
            v.contentDOM.style.paddingBottom = pad === 0 ? "" : `${pad}px`;
          },
        });
      }
      destroy(): void {
        this.view.contentDOM.style.paddingTop = "";
        this.view.contentDOM.style.paddingBottom = "";
      }
    },
  );
}

/**
 * The caret's line, centred in the editor's own scroller and NOWHERE else. CodeMirror's
 * `scrollIntoView` walks up the DOM and applies the strategy to every scrollable ancestor,
 * so a centred caret would drag the studio — and the page under it — along on each
 * keystroke. Scrolling the one box by hand keeps the carriage local to the paper.
 */
const keepCaretCentred = EditorView.updateListener.of((u: ViewUpdate) => {
  if (!u.docChanged && !u.selectionSet) return;
  if (!u.view.hasFocus) return;
  // In the measure cycle, so the read sees the updated layout, and reading the caret then
  // rather than now, so a fast typist's later keystroke wins. Setting scrollTop changes
  // neither the doc nor the selection, so this cannot feed itself.
  u.view.requestMeasure<number | null>({
    read: (v) => {
      const scroller = v.scrollDOM;
      if (!clips(scroller)) return null; // page-scrolled: not ours to move
      const caret = v.coordsAtPos(v.state.selection.main.head);
      if (caret === null) return null;
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      return scroller.scrollTop + (caret.top + caret.bottom) / 2 - (top + scroller.clientHeight / 2);
    },
    write: (target, v) => {
      if (target !== null) v.scrollDOM.scrollTop = target; // the browser clamps the ends
    },
  });
});

const platenLine = Decoration.line({ class: "cm-typewriter-line" });

/**
 * The line the caret is on, lit behind the text. Held still in the middle of the box while
 * the words move under it, the caret alone is a thin thing to keep your eye on — this is
 * the platen the carriage sits against, and it says "here" at a glance.
 */
const highlightCaretLine = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = caretLineDeco(view.state);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet) this.decorations = caretLineDeco(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

function caretLineDeco(state: EditorState): DecorationSet {
  return Decoration.set([platenLine.range(state.doc.lineAt(state.selection.main.head).from)]);
}

const platenTheme = EditorView.theme({
  // Only while focused: an unfocused editor is not where anyone is looking. A wash that
  // fades out rather than a block of colour, so it never reads as a selection.
  "&.cm-focused .cm-typewriter-line": {
    background: "linear-gradient(90deg, color-mix(in srgb, var(--accent) 13%, transparent), transparent 92%)",
    boxShadow: "inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent)",
    borderRadius: "3px",
  },
});

/** Typewriter scrolling, as a swappable slice of the setup (see {@link typewriterPadding}). */
export function typewriterExtension(): Extension {
  return [typewriterPadding(), keepCaretCentred, highlightCaretLine, platenTheme];
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
