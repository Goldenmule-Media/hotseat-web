"use client";

/**
 * Create a page from the sidebar (feature: create pages from the sidebar). Opened by the `+`
 * in the workspace title row; the browser-side engine appends the commit and the live tail
 * repaints the tree, so nothing here refreshes a view by hand.
 *
 * The form is type + title + parent, and that is the WHOLE contract: the engine's structural
 * handler reads only those three, and the registry lints against a type gating a field on its
 * own initial status (pages are born empty). There is no create-arg schema to render — what a
 * page still owes is authored afterwards through the FSM surface that already exists.
 *
 * The engine stays the sole validator: a duplicate sibling title, an archived parent or a
 * duplicate required child surfaces verbatim and leaves the modal open to correct.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { useLiveWorkspace, useStructuralMutator } from "../lib/live";
import { pageTypes } from "../lib/models";
import { filterPageTypeOptions, pageTypeOptions } from "../lib/page-types";
import { pageHref } from "../lib/routes";
import { parentOptions } from "../lib/tree";
import { ModalPortal } from "./ModalPortal";

export function CreatePageModal({
  workspaceId,
  initialParentId = null,
  onClose,
}: {
  workspaceId: WorkspaceId;
  /** Preselected parent — set when opened from a tree row's `+`. Null = top level. */
  initialParentId?: PageId | null;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const ws = useLiveWorkspace(workspaceId);
  const { create, pending, error } = useStructuralMutator(workspaceId);

  const options = useMemo(() => pageTypeOptions(pageTypes.map((t) => t.__def)), []);
  const labelOfType = useMemo(() => new Map(options.map((o) => [o.type, o.label])), [options]);
  const parents = useMemo(() => parentOptions(ws.tree), [ws.tree]);

  const titleRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  // "" is the top level (parentId null) — a select can't carry null as a value.
  const [parent, setParent] = useState<string>(initialParentId ?? "");

  // Picking a type is the first decision; move the cursor straight on to naming it.
  useEffect(() => {
    if (type !== null) titleRef.current?.focus();
  }, [type]);

  const shown = useMemo(() => filterPageTypeOptions(options, filter), [options, filter]);
  const selected = options.find((o) => o.type === type) ?? null;
  const canSubmit = type !== null && title.trim() !== "" && !pending;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (type === null || !canSubmit) return;
    const id = await create(type, title.trim(), parent === "" ? null : (parent as PageId));
    if (id === null) return; // error is rendered below; leave the modal open to correct
    onClose();
    router.push(pageHref(workspaceId, id));
  }

  return (
    <ModalPortal>
      <div
        className="modal-overlay"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="modal-card cp-card"
          role="dialog"
          aria-modal="true"
          aria-label="New page"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        >
          <header className="cp-head">
            <h2>New page</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </header>

          <form className="cp-form" onSubmit={submit}>
            <fieldset className="cp-types" disabled={pending}>
              <legend className="cp-legend">Page type</legend>
              <input
                type="text"
                className="cp-filter"
                value={filter}
                autoFocus
                placeholder="Filter types…"
                aria-label="Filter page types"
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  // Enter picks the best match rather than submitting a type-less form.
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const first = shown[0];
                  if (first !== undefined) setType(first.type);
                }}
              />
              <div className="cp-type-list">
                {shown.map((o) => (
                  <label
                    key={o.type}
                    className={`cp-type${type === o.type ? " cp-type-on" : ""}`}
                    title={o.description}
                  >
                    <input
                      type="radio"
                      name="page-type"
                      value={o.type}
                      checked={type === o.type}
                      onChange={() => setType(o.type)}
                    />
                    <span className="cp-type-head">
                      <span className="cp-type-label">{o.label}</span>
                      <code className="cp-type-tag">{o.type}</code>
                    </span>
                  </label>
                ))}
                {shown.length === 0 && <p className="muted cp-type-none">No page type matches “{filter}”.</p>}
              </div>
            </fieldset>

            <div className="cp-field">
              <label htmlFor="cp-title">
                Title<span className="tf-req"> *</span>
              </label>
              <input
                id="cp-title"
                ref={titleRef}
                type="text"
                value={title}
                disabled={pending}
                placeholder="Unique among its siblings"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="cp-field">
              <label htmlFor="cp-parent">Parent</label>
              <select id="cp-parent" value={parent} disabled={pending} onChange={(e) => setParent(e.target.value)}>
                <option value="">(Top level)</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${"\u00a0\u00a0".repeat(p.depth)}${p.title}`}
                  </option>
                ))}
              </select>
            </div>

            {selected !== null && selected.requiredChildren.length > 0 && (
              <p className="muted cp-children">
                Also creates: {selected.requiredChildren.map((c) => labelOfType.get(c) ?? c).join(", ")}
              </p>
            )}

            {error !== null && <div className="notice error">{error}</div>}

            <footer className="cp-actions">
              <button type="button" className="tf-btn tf-btn-secondary" onClick={onClose} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className="tf-btn tf-btn-primary" disabled={!canSubmit}>
                {pending ? "Creating…" : "Create"}
              </button>
            </footer>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}
