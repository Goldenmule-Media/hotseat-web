"use client";

/**
 * The Recipe Studio — the browser UI for `recipe` pages, and a kitchen surface rather than
 * a document view.
 *
 * TWO PANES, because cooking asks two different questions of the same list. On the left the
 * ingredients as the recipe organizes them (3 eggs for the dough, 2 for the wash) or the
 * shopping list that adds them back up; on the right the method. Hovering either side
 * highlights the other, so "which of these eggs is the wash" is answered by pointing.
 *
 * The shopping list is recomputed here from the same rows and the same `wiki-models/recipe`
 * unit functions the model's derived projection uses, so the pane and the rendered Markdown
 * cannot disagree — and the total updates while a quantity is still being typed.
 *
 * Unit conversion is a HINT, never a rewrite. Toggling grams shows `≈ 120 g` beside a
 * quantity; the stored value stays exactly as the recipe wrote it, because a recipe that
 * says "3 ½ cups" should keep saying so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { convert, formatMeasure, toggleTarget, UNIT_TOKENS } from "wiki-models/recipe";

import { resolveAttachment, uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionDocument, useSectionElements } from "../lib/live";
import {
  FILES_SECTION,
  groupIngredients,
  type Ingredient,
  INGREDIENTS_SECTION,
  ingredientsForStep,
  measureOf,
  type Note,
  NOTES_SECTION,
  readFiles,
  readIngredients,
  readNotes,
  readSteps,
  type RecipeFile,
  shoppingList,
  type Step,
  STEPS_SECTION,
  titleFromBody,
} from "../lib/recipe";
import { useStagedText } from "../lib/staged-text";
import { MarkdownEditor } from "./MarkdownEditor";

type LeftTab = "ingredients" | "shopping";
type RightTab = "instructions" | "pdf" | "notes";

type Run = (command: string, args: Record<string, unknown>) => Promise<boolean>;

export function RecipeStudio({
  workspaceId,
  pageId,
  pageMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  /** The whole page's rendered Markdown — `files` is a blocks field with no elements to
   *  summarize, so the render is where its attachment refs exist in one piece. */
  pageMarkdown: string | null;
}): React.JSX.Element {
  const ingredientEls = useSectionElements(workspaceId, pageId, INGREDIENTS_SECTION);
  const stepEls = useSectionElements(workspaceId, pageId, STEPS_SECTION);
  const stepDoc = useSectionDocument(workspaceId, pageId, STEPS_SECTION);
  const noteEls = useSectionElements(workspaceId, pageId, NOTES_SECTION);
  const noteDoc = useSectionDocument(workspaceId, pageId, NOTES_SECTION);
  const { run, error, reset } = usePageMutator(workspaceId, pageId);

  const ingredients = useMemo(() => readIngredients(ingredientEls.elements), [ingredientEls.elements]);
  const steps = useMemo(() => readSteps(stepEls.elements, stepDoc.notes), [stepEls.elements, stepDoc.notes]);
  const shopping = useMemo(() => shoppingList(ingredients), [ingredients]);
  const notes = useMemo(() => readNotes(noteEls.elements, noteDoc.notes), [noteEls.elements, noteDoc.notes]);
  const files = useMemo(() => readFiles(pageMarkdown), [pageMarkdown]);
  const documents = useMemo(() => files.filter((f) => !f.isImage), [files]);

  const [leftTab, setLeftTab] = useState<LeftTab>("ingredients");
  const [rightTab, setRightTab] = useState<RightTab>("instructions");
  const [showGrams, setShowGrams] = useState(false);
  /** Ingredient ids lit by whatever the pointer is over, on either side. */
  const [lit, setLit] = useState<readonly string[]>([]);

  const litSet = useMemo(() => new Set(lit), [lit]);

  const highlightStep = useCallback(
    (step: Step | null) => setLit(step === null ? [] : ingredientsForStep(ingredients, step)),
    [ingredients],
  );

  const groups = useMemo(() => groupIngredients(ingredients), [ingredients]);

  return (
    <div className="recipe-studio">
      {error !== null && (
        <p className="recipe-error" role="alert" onClick={reset}>
          {error}
        </p>
      )}

      <div className="recipe-panes">
        <section className="recipe-pane recipe-pane-left" aria-label="Ingredients">
          <header className="recipe-tabs">
            <button
              type="button"
              className={leftTab === "ingredients" ? "active" : ""}
              onClick={() => setLeftTab("ingredients")}
            >
              Ingredients
            </button>
            <button
              type="button"
              className={leftTab === "shopping" ? "active" : ""}
              onClick={() => setLeftTab("shopping")}
            >
              Shopping list
            </button>
            <label className="recipe-grams">
              <input type="checkbox" checked={showGrams} onChange={(e) => setShowGrams(e.target.checked)} />
              Grams
            </label>
          </header>

          {leftTab === "ingredients" ? (
            <div className="recipe-ingredients">
              {ingredients.length === 0 && !ingredientEls.loading && (
                <p className="muted">No ingredients yet.</p>
              )}
              {groups.map(({ group, items }) => (
                <div className="recipe-group" key={group === "" ? "__ungrouped" : group}>
                  {group !== "" && <h3 className="recipe-group-name">{group}</h3>}
                  {items.map((item) => (
                    <IngredientRow
                      key={item.id}
                      ingredient={item}
                      steps={steps}
                      showGrams={showGrams}
                      lit={litSet.has(item.id)}
                      onHover={(on) => setLit(on ? [item.id] : [])}
                      run={run}
                    />
                  ))}
                </div>
              ))}
              <AddIngredient run={run} groups={groups.map((g) => g.group).filter((g) => g !== "")} />
            </div>
          ) : (
            <ul className="recipe-shopping">
              {shopping.length === 0 && <li className="muted">Nothing to buy.</li>}
              {shopping.map((row) => (
                <li
                  key={row.key}
                  className={row.from.some((id) => litSet.has(id)) ? "lit" : ""}
                  onPointerEnter={() => setLit(row.from)}
                  onPointerLeave={() => setLit([])}
                >
                  <span className="recipe-total">{row.total}</span> {row.label}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="recipe-pane recipe-pane-right" aria-label="Instructions">
          <header className="recipe-tabs">
            <button
              type="button"
              className={rightTab === "instructions" ? "active" : ""}
              onClick={() => setRightTab("instructions")}
            >
              Instructions
            </button>
            {/* The PDF tab exists only when there is a document to show — an empty viewer
                is worse than no tab at all. */}
            {documents.length > 0 && (
              <button type="button" className={rightTab === "pdf" ? "active" : ""} onClick={() => setRightTab("pdf")}>
                {documents.length === 1 ? "PDF" : `Files (${documents.length})`}
              </button>
            )}
            <button
              type="button"
              className={rightTab === "notes" ? "active" : ""}
              onClick={() => setRightTab("notes")}
            >
              Notes{notes.length > 0 ? ` (${notes.length})` : ""}
            </button>
          </header>

          {rightTab === "instructions" ? (
            <>
              <ol className="recipe-steps">
                {steps.length === 0 && !stepEls.loading && <li className="muted">No steps yet.</li>}
                {steps.map((step, index) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    index={index}
                    total={steps.length}
                    paired={ingredientsForStep(ingredients, step).length > 0}
                    onHover={(on) => highlightStep(on ? step : null)}
                    run={run}
                  />
                ))}
              </ol>
              <AddStep run={run} />
            </>
          ) : rightTab === "pdf" ? (
            <FilesTab workspaceId={workspaceId} documents={documents} run={run} />
          ) : (
            <NotesTab notes={notes} loading={noteEls.loading} run={run} />
          )}
        </section>
      </div>
    </div>
  );
}

// ── ingredients ──────────────────────────────────────────────────────────────

/** One editable cell: shows the engine's value until you type, then your draft until the
 *  engine reads back — the same staging every studio here uses. Commits on blur. */
function useCell(stored: string, commit: (text: string) => Promise<boolean>): {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  onBlur: () => void;
} {
  const staged = useStagedText(stored);
  const onBlur = useCallback(() => {
    const text = staged.draft;
    if (text === null || text === stored) staged.drop();
    else void commit(text).then((ok) => (ok ? staged.saved(text) : staged.drop()));
  }, [staged, stored, commit]);
  return { value: staged.value, onChange: (e) => staged.edit(e.target.value), onBlur };
}

function IngredientRow({
  ingredient,
  steps,
  showGrams,
  lit,
  onHover,
  run,
}: {
  ingredient: Ingredient;
  steps: readonly Step[];
  showGrams: boolean;
  lit: boolean;
  onHover: (on: boolean) => void;
  run: Run;
}): React.JSX.Element {
  const revise = useCallback(
    (field: string) => (value: string) => run("reviseIngredient", { ingredientId: ingredient.id, [field]: value }),
    [run, ingredient.id],
  );

  const name = useCell(ingredient.name, revise("title"));
  const qty = useCell(ingredient.qty, revise("qty"));
  const unit = useCell(ingredient.unit, revise("unit"));
  const prep = useCell(ingredient.prep, revise("prep"));

  const hint = useMemo(() => {
    if (!showGrams) return "";
    const measure = measureOf(ingredient);
    const target = toggleTarget(measure, ingredient.name);
    if (target === null) return "";
    const converted = convert(measure, target, ingredient.name);
    return converted === null ? "" : `≈ ${formatMeasure(converted)}`;
  }, [showGrams, ingredient]);

  const pairedTo = steps.find((s) => s.id === ingredient.stepId);

  return (
    <div
      className={`recipe-ingredient${lit ? " lit" : ""}`}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <input className="recipe-qty" aria-label="Quantity" {...qty} />
      <input className="recipe-unit" aria-label="Unit" list="recipe-units" {...unit} />
      <input className="recipe-name" aria-label="Ingredient" {...name} />
      <input className="recipe-prep" aria-label="Preparation" placeholder="prep" {...prep} />
      {hint !== "" && <span className="recipe-hint">{hint}</span>}
      {pairedTo !== undefined && <span className="recipe-paired" title={`Used in: ${pairedTo.title}`}>◆</span>}
      <button
        type="button"
        className="recipe-remove"
        aria-label={`Remove ${ingredient.name}`}
        onClick={() => void run("removeIngredient", { ingredientId: ingredient.id })}
      >
        ×
      </button>
      <datalist id="recipe-units">
        {UNIT_TOKENS.map((token) => (
          <option key={token} value={token} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * One line in, one ingredient out. Typing "3.5 C all purpose flour" is how a recipe is
 * actually transcribed, so the row splits on the first two words when they read as a
 * quantity and a unit, and otherwise takes the whole line as the name.
 */
function AddIngredient({ run, groups }: { run: Run; groups: readonly string[] }): React.JSX.Element {
  const [text, setText] = useState("");
  const [group, setGroup] = useState("");

  const submit = useCallback(async () => {
    const line = text.trim();
    if (line === "") return;
    const parts = line.split(/\s+/);
    let qty = "";
    let unit = "";
    let rest = parts;
    if (parts.length > 1 && /^[\d./¼½¾⅓⅔⅛⅜⅝⅞]+$/.test(parts[0]!)) {
      qty = parts[0]!;
      rest = parts.slice(1);
      // "1 1/2 cups" — a second numeric word is still the quantity.
      if (rest.length > 1 && /^[\d./¼½¾⅓⅔⅛⅜⅝⅞]+$/.test(rest[0]!)) {
        qty = `${qty} ${rest[0]!}`;
        rest = rest.slice(1);
      }
      if (rest.length > 1 && UNIT_TOKENS.includes(rest[0]!.toLowerCase().replace(/s$/, ""))) {
        unit = rest[0]!;
        rest = rest.slice(1);
      } else if (rest.length > 1) {
        unit = rest[0]!;
        rest = rest.slice(1);
      }
    }
    const ok = await run("addIngredient", {
      title: rest.join(" "),
      ...(qty !== "" ? { qty } : {}),
      ...(unit !== "" ? { unit } : {}),
      ...(group !== "" ? { group } : {}),
    });
    if (ok) setText("");
  }, [text, group, run]);

  return (
    <form
      className="recipe-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="3.5 C all purpose flour"
        aria-label="Add an ingredient"
      />
      <input
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        placeholder="group"
        aria-label="Group"
        list="recipe-groups"
      />
      <datalist id="recipe-groups">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button type="submit">Add</button>
    </form>
  );
}

// ── steps ────────────────────────────────────────────────────────────────────

function StepCard({
  step,
  index,
  total,
  paired,
  onHover,
  run,
}: {
  step: Step;
  index: number;
  total: number;
  paired: boolean;
  onHover: (on: boolean) => void;
  run: Run;
}): React.JSX.Element {
  const title = useCell(step.title, (text) =>
    run("reviseStep", { stepId: step.id, title: text === "" ? step.title : text, markdown: step.body }),
  );
  const [body, setBody] = useState<string | null>(null);
  const shown = body ?? step.body;

  const saveBody = useCallback(() => {
    if (body === null || body === step.body) {
      setBody(null);
      return;
    }
    void run("reviseStep", { stepId: step.id, markdown: body }).then(() => setBody(null));
  }, [body, step.body, step.id, run]);

  return (
    <li
      className={`recipe-step${paired ? " has-pairing" : ""}`}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <div className="recipe-step-head">
        <span className="recipe-step-n">{index + 1}</span>
        <input className="recipe-step-title" aria-label="Step title" {...title} />
        <span className="recipe-step-controls">
          <button
            type="button"
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => void run("moveStep", { stepId: step.id, toIndex: index - 1 })}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Move down"
            disabled={index === total - 1}
            onClick={() => void run("moveStep", { stepId: step.id, toIndex: index + 1 })}
          >
            ↓
          </button>
          <button type="button" aria-label="Remove step" onClick={() => void run("removeStep", { stepId: step.id })}>
            ×
          </button>
        </span>
      </div>
      <MarkdownEditor
        value={shown}
        onChange={setBody}
        onBlur={saveBody}
        terms={[]}
        onTermClick={() => undefined}
        placeholder="What to do…"
      />
    </li>
  );
}

/** A step is one field to author: the title falls out of the first clause unless it is
 *  edited afterwards, so transcribing prose steps stays typing-and-Enter. */
function AddStep({ run }: { run: Run }): React.JSX.Element {
  const [text, setText] = useState("");

  const submit = useCallback(async () => {
    const markdown = text.trim();
    if (markdown === "") return;
    const ok = await run("addStep", { title: titleFromBody(markdown), markdown });
    if (ok) setText("");
  }, [text, run]);

  return (
    <form
      className="recipe-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Mix. Knead for 6 minutes."
        aria-label="Add a step"
      />
      <button type="submit">Add</button>
    </form>
  );
}

// ── the original, as a document ──────────────────────────────────────────────

/**
 * The recipe's own file, shown next to the transcription. Half of a recipe collection is a
 * printed page that was never typed up, and the transcription is often only the parts worth
 * changing — so the original has to stay one click away, not one navigation away.
 *
 * Bytes are fetched with the bearer and handed to the viewer as an object URL;
 * `resolveAttachment` caches that promise per blob, so switching tabs never refetches.
 */
function FilesTab({
  workspaceId,
  documents,
  run,
}: {
  workspaceId: WorkspaceId;
  documents: readonly RecipeFile[];
  run: Run;
}): React.JSX.Element {
  const [shown, setShown] = useState(0);
  const current = documents[Math.min(shown, documents.length - 1)];
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (current === undefined) return;
    let live = true;
    setSrc(null);
    setFailed(false);
    const id = /^attachment:([0-9a-f]{64})$/.exec(current.ref)?.[1];
    if (id === undefined) {
      setSrc(current.ref);
      return;
    }
    void resolveAttachment(workspaceId, id).then((url) => {
      if (!live) return;
      if (url === null) setFailed(true);
      else setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, current]);

  return (
    <div className="recipe-files">
      {documents.length > 1 && (
        <div className="recipe-file-picker">
          {documents.map((doc, i) => (
            <button key={doc.ref} type="button" className={i === shown ? "active" : ""} onClick={() => setShown(i)}>
              {doc.label}
            </button>
          ))}
        </div>
      )}
      {failed ? (
        <p className="muted">That file could not be loaded.</p>
      ) : src === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <iframe className="recipe-viewer" src={src} title={current?.label ?? "Attached file"} />
      )}
      <AttachDropZone workspaceId={workspaceId} run={run} />
    </div>
  );
}

function AttachDropZone({ workspaceId, run }: { workspaceId: WorkspaceId; run: Run }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) return;
      setBusy(true);
      setProblem(null);
      try {
        const ref = await uploadAttachment(workspaceId, file);
        await run("attachFile", { ref, label: file.name, isImage: file.type.startsWith("image/") });
      } catch {
        setProblem("That file could not be uploaded.");
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, run],
  );

  return (
    <div
      className="recipe-drop"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void take(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : "Attach the original…"}
      </button>
      {problem !== null && <span className="recipe-drop-error">{problem}</span>}
    </div>
  );
}

// ── notes ────────────────────────────────────────────────────────────────────

/**
 * The attempt log: what you changed the third time you made this and how it turned out.
 * Newest first, because the last thing you did is what you want to read before doing it
 * again — the stored order stays authoring order, and only the display is reversed.
 */
function NotesTab({
  notes,
  loading,
  run,
}: {
  notes: readonly Note[];
  loading: boolean;
  run: Run;
}): React.JSX.Element {
  const newest = useMemo(() => [...notes].reverse(), [notes]);
  return (
    <div className="recipe-notes">
      <AddNote run={run} />
      {notes.length === 0 && !loading && <p className="muted">No notes yet.</p>}
      {newest.map((note) => (
        <NoteCard key={note.id} note={note} run={run} />
      ))}
    </div>
  );
}

function NoteCard({ note, run }: { note: Note; run: Run }): React.JSX.Element {
  const title = useCell(note.title, (text) =>
    run("reviseNote", { noteId: note.id, title: text === "" ? note.title : text, markdown: note.body }),
  );
  const [body, setBody] = useState<string | null>(null);

  const saveBody = useCallback(() => {
    if (body === null || body === note.body) {
      setBody(null);
      return;
    }
    void run("reviseNote", { noteId: note.id, markdown: body }).then(() => setBody(null));
  }, [body, note.body, note.id, run]);

  return (
    <article className="recipe-note">
      <div className="recipe-note-head">
        <input className="recipe-note-title" aria-label="Note label" {...title} />
        <button type="button" aria-label="Remove note" onClick={() => void run("removeNote", { noteId: note.id })}>
          ×
        </button>
      </div>
      <MarkdownEditor
        value={body ?? note.body}
        onChange={setBody}
        onBlur={saveBody}
        terms={[]}
        onTermClick={() => undefined}
        placeholder="What you changed, and how it turned out…"
      />
    </article>
  );
}

function AddNote({ run }: { run: Run }): React.JSX.Element {
  const [label, setLabel] = useState("");

  const submit = useCallback(async () => {
    const title = label.trim();
    if (title === "") return;
    const ok = await run("addNote", { title, markdown: "" });
    if (ok) setLabel("");
  }, [label, run]);

  return (
    <form
      className="recipe-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Today, or which attempt this was"
        aria-label="Add a note"
      />
      <button type="submit">Add note</button>
    </form>
  );
}
