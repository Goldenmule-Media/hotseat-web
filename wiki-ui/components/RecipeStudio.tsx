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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { UNIT_TOKENS } from "wiki-models/recipe";

import { resolveAttachment, uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionDocument, useSectionElements } from "../lib/live";
import {
  applyOverlay,
  applyProposal,
  askRecipeChat,
  type ChatTurn,
  describeOp,
  FILES_SECTION,
  groupIngredients,
  type Ingredient,
  INGREDIENTS_SECTION,
  ingredientsForStep,
  type Note,
  type Overlay,
  parseIngredientLine,
  type OverlayIngredient,
  type OverlayStep,
  type ProposedOp,
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
  pageTitle,
  status,
  pageMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  pageTitle: string;
  status: string;
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
  const notes = useMemo(() => readNotes(noteEls.elements, noteDoc.notes), [noteEls.elements, noteDoc.notes]);
  const files = useMemo(() => readFiles(pageMarkdown), [pageMarkdown]);
  const documents = useMemo(() => files.filter((f) => !f.isImage), [files]);

  const [leftTab, setLeftTab] = useState<LeftTab>("ingredients");
  const [rightTab, setRightTab] = useState<RightTab>("instructions");
  /** The chat's proposal, held in memory. Nothing here has been written. */
  const [proposal, setProposal] = useState<readonly ProposedOp[]>([]);
  /** Ingredient ids lit by whatever the pointer is over, on either side. */
  const [lit, setLit] = useState<readonly string[]>([]);
  /** Groups the human has named but not yet filled — see the comment at their render. */
  const [pendingGroups, setPendingGroups] = useState<readonly string[]>([]);

  const litSet = useMemo(() => new Set(lit), [lit]);

  // While a proposal is open the panes draw the PROPOSED recipe, so a change is judged by
  // reading the recipe it would produce rather than a diff beside it. Nothing is written.
  const overlay: Overlay = useMemo(() => applyOverlay(ingredients, steps, proposal), [ingredients, steps, proposal]);
  const shownIngredients: readonly OverlayIngredient[] = overlay.ingredients;
  const shownSteps: readonly OverlayStep[] = overlay.steps;
  const groups = useMemo(() => groupIngredients(shownIngredients), [shownIngredients]);
  const shopping = useMemo(
    () => shoppingList(shownIngredients.filter((i) => i.change !== "removed")),
    [shownIngredients],
  );

  const highlightStep = useCallback(
    (step: Step | null) => setLit(step === null ? [] : ingredientsForStep(shownIngredients, step)),
    [shownIngredients],
  );

  return (
    <div className="recipe-studio">
      {error !== null && (
        <p className="recipe-error" role="alert" onClick={reset}>
          {error}
        </p>
      )}

      {/* The one FSM edge a recipe has. It is the studio's job to offer it: the studio is
          the default view, so without this the only way to mark a recipe made is the
          generic model view, which is not where anyone is standing after cooking. */}
      <div className="recipe-status">
        {status === "made" ? (
          <>
            <span className="recipe-made">Made</span>
            <button type="button" onClick={() => void run("reopen", {})}>
              Not yet
            </button>
          </>
        ) : (
          <>
            <span className="muted">Untried</span>
            <button type="button" className="primary" onClick={() => void run("made", {})}>
              I made this
            </button>
          </>
        )}
      </div>

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
          </header>

          {leftTab === "ingredients" ? (
            <div className="recipe-ingredients">
              {shownIngredients.length === 0 && !ingredientEls.loading && (
                <p className="muted">No ingredients yet.</p>
              )}
              {groups.map(({ group, items }) => (
                <IngredientGroup
                  key={group === "" ? "__ungrouped" : group}
                  group={group}
                  items={items}
                  steps={steps}
                  lit={litSet}
                  onHover={setLit}
                  run={run}
                />
              ))}
              {/* A group with no ingredients yet exists only here: the model derives groups
                  from the ingredients that name them, so there is nothing to create until
                  the first one lands. */}
              {pendingGroups
                .filter((name) => !groups.some((g) => g.group === name))
                .map((name) => (
                  <IngredientGroup
                    key={`pending:${name}`}
                    group={name}
                    items={[]}
                    steps={steps}
                    lit={litSet}
                    onHover={setLit}
                    run={run}
                    onDismiss={() => setPendingGroups((names) => names.filter((n) => n !== name))}
                  />
                ))}
              <InlineAddField
                placeholder="+ group"
                aria="Add a group"
                onSubmit={(name) => {
                  const trimmed = name.trim();
                  if (trimmed === "") return false;
                  setPendingGroups((names) => (names.includes(trimmed) ? names : [...names, trimmed]));
                  return true;
                }}
              />
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
                  <span className="recipe-shop-name">{row.label}</span>
                  <span className="recipe-total">{row.total}</span>
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
                {shownSteps.length === 0 && !stepEls.loading && <li className="muted">No steps yet.</li>}
                {shownSteps.map((step, index) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    change={step.change}
                    index={index}
                    total={shownSteps.length}
                    paired={ingredientsForStep(shownIngredients, step).length > 0}
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

      <ChatBar
        title={pageTitle}
        ingredients={ingredients}
        steps={steps}
        proposal={proposal}
        onPropose={setProposal}
        run={run}
      />
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

/** A cell that wraps rather than clipping: an `<input>` hides a long ingredient name past
 *  the right edge of a narrow pane, so name and prep are textareas grown to fit. Newlines
 *  are folded to spaces on the way in and Enter commits, so it still behaves like a field. */
function WrapCell({
  className,
  label,
  placeholder,
  cell,
}: {
  className: string;
  label: string;
  placeholder?: string;
  cell: ReturnType<typeof useCell>;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight + 2}px`; // scrollHeight leaves out the transparent border
  }, [cell.value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      aria-label={label}
      placeholder={placeholder}
      value={cell.value}
      onChange={(e) => cell.onChange({ target: { value: e.target.value.replace(/\s*\n\s*/g, " ") } })}
      onBlur={cell.onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function IngredientRow({
  ingredient,
  change,
  steps,
  lit,
  onHover,
  run,
}: {
  ingredient: Ingredient;
  /** Set while the chat's proposal is open — the row is styled, and frozen against edits
   *  that would be written straight through underneath an unapplied change. */
  change?: "added" | "changed" | "removed";
  steps: readonly Step[];
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


  const pairedTo = steps.find((s) => s.id === ingredient.stepId);

  return (
    <div
      className={`recipe-ingredient${lit ? " lit" : ""}${change === undefined ? "" : ` proposed-${change}`}`}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <input className="recipe-qty" aria-label="Quantity" {...qty} />
      <input className="recipe-unit" aria-label="Unit" list="recipe-units" {...unit} />
      <WrapCell className="recipe-name" label="Ingredient" cell={name} />
      <WrapCell className="recipe-prep" label="Preparation" placeholder="prep" cell={prep} />
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
 * One group of ingredients, with its own add row.
 *
 * Adding belongs INSIDE the group rather than in one form at the foot of the pane: the group
 * is then implied by where you are typing, which is one less field per ingredient and the
 * difference between transcribing a recipe and filling in a form.
 */
function IngredientGroup({
  group,
  items,
  steps,
  lit,
  onHover,
  run,
  onDismiss,
}: {
  group: string;
  items: readonly OverlayIngredient[];
  steps: readonly Step[];
  lit: ReadonlySet<string>;
  onHover: (ids: readonly string[]) => void;
  run: Run;
  /** Set only for a group that exists client-side and holds nothing yet. */
  onDismiss?: () => void;
}): React.JSX.Element {
  /** Removing a group keeps its ingredients and ungroups them. Deleting someone's
   *  ingredients because they renamed a heading would be a trap. */
  const removeGroup = useCallback(async () => {
    for (const item of items) await run("reviseIngredient", { ingredientId: item.id, group: "" });
    onDismiss?.();
  }, [items, run, onDismiss]);

  const [adding, setAdding] = useState(false);

  return (
    <div className="recipe-group">
      <div className="recipe-group-head">
        <h3 className="recipe-group-name">{group}</h3>
        <button
          type="button"
          className="recipe-group-add"
          aria-label={group === "" ? "Add an ingredient" : `Add an ingredient to ${group}`}
          title="Add an ingredient"
          onClick={() => setAdding(true)}
        >
          +
        </button>
        {group !== "" && (
          <button
            type="button"
            className="recipe-group-remove"
            aria-label={`Remove the ${group} group`}
            title="Remove this group. Its ingredients stay, ungrouped."
            onClick={() => void removeGroup()}
          >
            ×
          </button>
        )}
      </div>
      {items.map((item) => (
        <IngredientRow
          key={item.id}
          ingredient={item}
          change={item.change}
          steps={steps}
          lit={lit.has(item.id)}
          onHover={(on) => onHover(on ? [item.id] : [])}
          run={run}
        />
      ))}
      {adding && (
        <InlineAddField
          placeholder="3.5 C all purpose flour"
          aria={group === "" ? "Add an ingredient" : `Add an ingredient to ${group}`}
          onCancel={() => setAdding(false)}
          onSubmit={async (line) => {
            const parsed = parseIngredientLine(line);
            if (parsed.title === "") return false;
            return run("addIngredient", { ...parsed, ...(group === "" ? {} : { group }) });
          }}
        />
      )}
    </div>
  );
}

/**
 * The add field itself. Submitting clears it but keeps it open, which is how a list gets
 * typed in; an empty Escape or blur closes it where the caller allows closing.
 */
function InlineAddField({
  placeholder,
  aria,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  aria: string;
  /** `true` when it took; the field then clears and stays open. */
  onSubmit: (text: string) => boolean | Promise<boolean>;
  /** Omitted for a field that is always present, like the group adder. */
  onCancel?: () => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    if (ok) setText("");
  }, [text, busy, onSubmit]);

  return (
    <form
      className="recipe-inline-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus={onCancel !== undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={aria}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text === "") onCancel?.();
        }}
        onBlur={() => {
          if (text === "") onCancel?.();
        }}
      />
      <button type="submit" disabled={busy || text.trim() === ""}>
        Add
      </button>
    </form>
  );
}

// ── steps ────────────────────────────────────────────────────────────────────

function StepCard({
  step,
  change,
  index,
  total,
  paired,
  onHover,
  run,
}: {
  step: Step;
  change?: "added" | "changed" | "removed";
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
      className={`recipe-step${paired ? " has-pairing" : ""}${change === undefined ? "" : ` proposed-${change}`}`}
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

// ── the chat ─────────────────────────────────────────────────────────────────

/**
 * A chat across the foot of both panes, because a substitution question is about the
 * ingredients AND the method at once.
 *
 * A proposed change is applied to the panes IN MEMORY: the recipe above rearranges to what
 * it would become, changed rows marked, and nothing has been written. Apply replays the
 * same ops as real mutations; Discard forgets them. That is the whole contract, and it is
 * why the proposal is a list of the model's own commands rather than free text — what you
 * read is exactly what gets written.
 */
function ChatBar({
  title,
  ingredients,
  steps,
  proposal,
  onPropose,
  run,
}: {
  title: string;
  ingredients: readonly Ingredient[];
  steps: readonly Step[];
  proposal: readonly ProposedOp[];
  onPropose: (ops: readonly ProposedOp[]) => void;
  run: Run;
}): React.JSX.Element {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [applying, setApplying] = useState(false);
  // The conversation lives here: the route is stateless, so each ask replays the recent turns.
  const history = useRef<ChatTurn[]>([]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (text === "" || asking) return;
    setAsking(true);
    setProblem(null);
    const result = await askRecipeChat({
      title,
      ingredients,
      steps,
      question: text,
      history: history.current,
    });
    setAsking(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    history.current = [
      ...history.current,
      { question: text, reply: result.answer.reply, proposal: result.answer.proposal },
    ].slice(-6);
    setAnswer(result.answer.reply);
    onPropose(result.answer.proposal);
    setQuestion("");
  }, [question, asking, title, ingredients, steps, onPropose]);

  const apply = useCallback(async () => {
    setApplying(true);
    const { failed } = await applyProposal(proposal, run);
    setApplying(false);
    onPropose([]);
    if (failed > 0) setProblem(`${failed} of those changes could not be applied.`);
  }, [proposal, run, onPropose]);

  return (
    <section className="recipe-chat" aria-label="Ask about this recipe">
      {answer !== null && <p className="recipe-chat-answer">{answer}</p>}
      {problem !== null && (
        <p className="recipe-chat-error" role="alert">
          {problem}
        </p>
      )}

      {proposal.length > 0 && (
        <div className="recipe-proposal">
          <ul>
            {proposal.map((op, i) => (
              <li key={`${op.command}:${i}`}>{describeOp(op, ingredients, steps)}</li>
            ))}
          </ul>
          <p className="recipe-proposal-note">Shown above, not saved.</p>
          <div className="recipe-proposal-actions">
            <button type="button" className="primary" disabled={applying} onClick={() => void apply()}>
              {applying ? "Applying…" : "Apply to recipe"}
            </button>
            <button type="button" disabled={applying} onClick={() => onPropose([])}>
              Discard
            </button>
          </div>
        </div>
      )}

      <form
        className="recipe-chat-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What can I use instead of buttermilk?"
          aria-label="Ask about this recipe"
          disabled={asking}
        />
        <button type="submit" disabled={asking || question.trim() === ""}>
          {asking ? "Thinking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
