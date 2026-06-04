/**
 * The command bus — the engine's hot path (DESIGN §5, §15; BUILD_NOTES §3, §4).
 *
 * `CommandBus` operates on ONE workspace `ProjectionEntry` (folded `state`, the
 * full in-memory `events[]` for `history()`, a DS cursor, snapshot bookkeeping,
 * and the fan-out subscriber set) supplied by the workspace handle. It owns the
 * pure validate → guard → build-context → decide → commit pipeline; the handle
 * owns the per-workspace mutex (the bus must be re-entrant so a rebase can re-run
 * the pipeline without re-acquiring the lock).
 *
 * Two entry points:
 *  - `runStructural(projection, {handler, args, …})` — structural commands.
 *  - `runPage(projection, {pageId, command, args, …})` — page-scoped FSM commands.
 *
 * Everything before `commit` is pure: no host clock / RNG. Time and ids ride in
 * exclusively via the injected {@link Services} (`now()` / `newId()`).
 */
import type {
  DeepReadonly,
  DeclarativeCommand,
  DomainEvent,
  FieldValueSpec,
  ICommandContext,
  IEventEnvelope,
  IEventMeta,
  IField,
  IItem,
  IRelatedReader,
  IWorkspaceState,
  PageId,
  PageState,
  RootId,
  SectionId,
  SectionOp,
  WorkspaceId,
} from "../api";
import {
  ConcurrencyError,
  FieldKindError,
  ItemNotFoundError,
  MutationNotAllowedError,
  PageNotFoundError,
  PreconditionUnmetError,
  SectionContractError,
  StaleEditError,
  WorkspaceArchivedError,
} from "./errors";
import type { IBlock, TextEdit } from "../api";
import { contentHash } from "./ingestion";
import { applyOps, normalizeFieldValue } from "./operations";
import type { GeneratedCommand, Registry } from "./registry";
import { writeSnapshot } from "./snapshot";
import { STRUCTURAL_HANDLERS, type StructureHandler } from "./structure";
import { isStaleAppend, type IEventLog, type ProjectionEntry, type Services } from "./types";
import { validatePage } from "./ingestion";
import { applyWorkspace, isStructuralEvent, pageStateView, SECTION_OPS_EVENT } from "./workspace";

/** Max rebase attempts before surfacing {@link ConcurrencyError}. */
const MAX_REBASE_ATTEMPTS = 5;

/**
 * The section a `SectionOp` EDITS THE CONTENT OF, or `undefined` if the op is not a
 * content edit of an existing section's body. The §6 write-gate (`mutableIn`) applies
 * per content op (DESIGN §6): field/element/block/meta edits are gated by their target
 * section's content gate; FSM `transition` ops (page or element lifecycle) and
 * section-tree ops (add/remove/move/renameSection — the section SET, not a body) are
 * gated by their own rules, never by a section's content `mutableIn`. Gating by the
 * engine's closed op vocabulary (the ground truth of what a command actually does) is
 * what cleanly separates "edit the set" from "drive an element" on one section.
 */
function contentOpSection(op: SectionOp): string | undefined {
  switch (op.op) {
    case "setField":
    case "applyTextEdits":
    case "addElement":
    case "removeElement":
    case "moveElement":
    case "setElementField":
    case "addBlock":
    case "removeBlock":
    case "moveBlock":
    case "setBlock":
    case "setMeta":
      return op.section;
    default:
      return undefined;
  }
}

/** Bus dependencies / configuration. */
export interface CommandBusConfig {
  readonly snapshotEvery: number;
  /** Optional sink for every appended event. Must not throw (we still guard it). */
  readonly onEvent?: (event: IEventEnvelope) => void;
}

/**
 * A committed write's outcome (DESIGN §5 step 6, §8.6): the command's `result`
 * value plus the **committed-head version** — the per-workspace `version` after the
 * append and any OCC rebase-retry. The handle turns `committedVersion` into a
 * {@link ConsistencyToken}. An idempotent / zero-event write reports the current head.
 */
export interface CommitOutcome {
  readonly result: unknown;
  /** The workspace `version` after this commit landed (== folded head). */
  readonly committedVersion: number;
}

/**
 * The bus's view of an open workspace: the standard {@link ProjectionEntry} plus
 * the FULL in-memory event log the handle keeps for `history()`. The bus appends
 * each committed/rebased envelope to `events` so `history()` is always complete.
 */
export interface BusProjection extends ProjectionEntry {
  /** Full ordered event history for this workspace (drives `handle.history()`). */
  readonly events: IEventEnvelope[];
}

/** A structural-command invocation. */
export interface StructuralRequest {
  /** Key into {@link STRUCTURAL_HANDLERS} (e.g. "createPage", "reparent", "archive"). */
  readonly handler: string;
  readonly args: unknown;
  readonly commandId?: string;
  readonly actor?: string;
}

/** A page-scoped command invocation. */
export interface PageRequest {
  readonly pageId: PageId;
  readonly command: string;
  readonly args: unknown;
  readonly commandId?: string;
  readonly actor?: string;
}

/**
 * The internal command bus. One instance per open workspace handle. Pure pipeline
 * + a single I/O step (the atomic append); rebases by reading the tail and
 * re-running the decision against fresh state.
 */
export class CommandBus {
  constructor(
    private readonly eventLog: IEventLog,
    private readonly registry: Registry,
    private readonly services: Services,
    private readonly config: CommandBusConfig,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Structural commands
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run a structural command. The decision is re-evaluated from scratch on each
   * (re)attempt against the latest folded state so a rebase re-checks invariants.
   * Resolves to a {@link CommitOutcome} (result + committed-head version, §8.6).
   */
  async runStructural(projection: BusProjection, req: StructuralRequest): Promise<CommitOutcome> {
    const handler = STRUCTURAL_HANDLERS[req.handler];
    if (handler === undefined) {
      // Unknown structural verb — treat as a forbidden mutation rather than a crash.
      throw new MutationNotAllowedError("workspace", projection.state.status, req.handler, [
        ...Object.keys(STRUCTURAL_HANDLERS),
      ]);
    }
    const decide = (state: IWorkspaceState) => this.decideStructural(handler, state, req);
    return this.commit(projection, decide, { actor: req.actor, commandId: req.commandId });
  }

  /** Pure structural decision: workspace must be active, then run the handler. */
  private decideStructural(
    handler: StructureHandler,
    state: IWorkspaceState,
    req: StructuralRequest,
  ): { events: DomainEvent[]; result: unknown } {
    if (state.status === "archived") {
      throw new WorkspaceArchivedError(state.id);
    }
    const { events, result } = handler(state, req.args, this.services, this.registry);
    return { events, result };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Page-scoped commands
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run a page-scoped command: validate args, guard the page FSM (and the item
   * FSM for item-level commands), build the command context, run the pure
   * `produces`, then commit. The decision is re-run on each rebase attempt.
   * Resolves to a {@link CommitOutcome} (result + committed-head version, §8.6).
   */
  async runPage(projection: BusProjection, req: PageRequest): Promise<CommitOutcome> {
    const decide = (state: IWorkspaceState) => this.decidePage(state, req);
    return this.commit(projection, decide, {
      actor: req.actor,
      commandId: req.commandId,
      // The SEMANTIC command label stamped on the content event's metadata (§9.4) —
      // keeps history semantic (`answerQuestion`, `renameSymbol`) without per-type
      // events. A command may override it with a `label` arg (e.g. a guarded
      // code-edit run as `renameSymbol`); otherwise the command name is used.
      command: this.labelFor(req),
      // Page-command events default to the target page when they omit `pageId`
      // (BUILD_NOTES §2). Structural commands set their own pageId explicitly.
      defaultPageId: req.pageId,
    });
  }

  /** The semantic label for a page command: an explicit `label` arg, else the command name. */
  private labelFor(req: PageRequest): string {
    const a = req.args;
    if (a !== null && typeof a === "object" && typeof (a as { label?: unknown }).label === "string") {
      return (a as { label: string }).label;
    }
    return req.command;
  }

  /** Pure page-command decision (resolve → validate → gate → effect → check). */
  private decidePage(
    state: IWorkspaceState,
    req: PageRequest,
  ): { events: DomainEvent[]; result: unknown } {
    if (state.status === "archived") {
      throw new WorkspaceArchivedError(state.id);
    }

    const node = state.pages.get(req.pageId);
    if (node === undefined) throw new PageNotFoundError(req.pageId);

    const def = this.registry.page(node.type);
    const guard = this.registry.pageGuard(node.type);
    const declared: DeclarativeCommand | undefined = def.commands[req.command];
    const generated: GeneratedCommand | undefined = this.registry
      .generatedCommands(node.type)
      .get(req.command);

    const allowedSet = (): string[] => [
      ...guard.available(node.status),
      ...this.contentCommands(node.type, node.status),
    ];

    if (declared === undefined && generated === undefined) {
      throw new MutationNotAllowedError(node.type, node.status, req.command, allowedSet());
    }

    const ctx = this.buildContext(state, req.pageId, req.actor, req.commandId);
    const view: PageState = pageStateView(node);

    // ── declarative command ──
    if (declared !== undefined) {
      const parsed = declared.args.parse(req.args) as Record<string, unknown>;

      // Page-FSM legality.
      if (declared.transition?.level === "page") {
        if (!guard.can(node.status, req.command)) {
          throw new MutationNotAllowedError(node.type, node.status, req.command, allowedSet());
        }
      }

      // Resolve the target element id (if any) up front — needed to build the ops.
      const targetSection = declared.target?.section;
      const resolvedElementId: string | undefined =
        declared.target?.element !== undefined ? (parsed[declared.target.element.idArg] as string) : undefined;

      // Build the ops, then apply the §6 write-gate PER OP. A content edit
      // (setField/addElement/setElementField/…) is gated by ITS target section's
      // `mutableIn`; an element-FSM `transition` op (e.g. markCasePassed) carries no
      // content, so it is gated ONLY by the element FSM below — never frozen by the
      // section's content gate. This lets "author the set in draft, then record
      // results in ready" be expressible on one section (feature-review Item 5),
      // while still freezing genuine content edits: answerQuestion emits a content
      // `setElementField` (its answer write — gated) AND an element transition (FSM
      // only), so sealing the section freezes the write but never the lifecycle.
      const ops = this.buildDeclarativeOps(view, declared, parsed, ctx, resolvedElementId);
      for (const op of ops) {
        const sec = contentOpSection(op);
        if (sec !== undefined) this.assertMutable(node.type, node.status, sec, req.command, allowedSet());
      }

      // element-level FSM legality.
      if (declared.transition?.level === "element" && declared.target?.element !== undefined) {
        this.checkElementTransition(node.type, view, targetSection!, resolvedElementId!, declared.transition.event, req.command);
      }

      // content-hash precondition on any code edit (re-runs on rebase, §5).
      this.assertEditPreconditions(view, ops);

      // preconditions.
      this.runPreconditions(declared, view, ctx.related);

      // well-formedness dry run.
      this.dryRunAndValidate(state, node.type, view, ops);

      const result = this.commandResult(declared, parsed, ops);
      if (ops.length === 0) return { events: [], result };
      return {
        events: [{ type: SECTION_OPS_EVENT, pageId: req.pageId, payload: { ops } }],
        result,
      };
    }

    // ── generated structural command ──
    const gen = generated as GeneratedCommand;
    this.assertMutable(node.type, node.status, gen.section, req.command, allowedSet());
    const parsed = (req.args ?? {}) as Record<string, unknown>;
    const ops = this.buildGeneratedOps(gen, parsed, ctx);
    this.assertEditPreconditions(view, ops);
    this.dryRunAndValidate(state, node.type, view, ops);
    const result = this.generatedResult(gen, ops);
    if (ops.length === 0) return { events: [], result };
    return {
      events: [{ type: SECTION_OPS_EVENT, pageId: req.pageId, payload: { ops } }],
      result,
    };
  }

  /** Content (generated + declared-with-target) command names mutable in `status`. */
  private contentCommands(type: string, status: string): string[] {
    const out: string[] = [];
    const decls = this.registry.sectionDeclsOf(type);
    for (const [name, gen] of this.registry.generatedCommands(type)) {
      const sd = decls[gen.section];
      if (sd?.mutableIn === undefined || sd.mutableIn.includes(status)) out.push(name);
    }
    const def = this.registry.page(type);
    for (const [name, cmd] of Object.entries(def.commands)) {
      if (cmd.target?.section !== undefined) {
        const sd = decls[cmd.target.section];
        if (sd?.mutableIn === undefined || sd.mutableIn.includes(status)) out.push(name);
      }
    }
    return out;
  }

  /** The §6 write-gate: the target section must be mutable in the current status. */
  private assertMutable(
    type: string,
    status: string,
    sectionKey: string,
    command: string,
    allowed: string[],
  ): void {
    const sd = this.registry.sectionDeclsOf(type)[sectionKey];
    if (sd?.mutableIn !== undefined && !sd.mutableIn.includes(status)) {
      throw new MutationNotAllowedError(type, status, command, allowed);
    }
  }

  private checkElementTransition(
    type: string,
    view: PageState,
    sectionKey: string,
    elementId: string,
    event: string,
    command: string,
  ): void {
    const sec = view.sections.find((s) => s.key === sectionKey);
    if (sec === undefined) throw new ItemNotFoundError(sectionKey, elementId);
    let elementType: string | undefined;
    let item: IItem | undefined;
    for (const f of Object.values(sec.fields)) {
      if (f.kind === "list") {
        const found = f.elements.find((e) => e.id === elementId);
        if (found !== undefined) {
          elementType = f.elementType;
          item = found;
          break;
        }
      }
    }
    if (item === undefined || elementType === undefined) {
      throw new ItemNotFoundError(sectionKey, elementId);
    }
    // A COMPUTED element's status is DERIVED (its checkbox is rendered from a flag), so it
    // must never be driven by hand — reject any element transition on it (Item 3). This
    // keeps the rendered checkbox the single source of truth and prevents a stored status
    // from silently diverging from the computed fact.
    if (item.meta?.["computed"] !== undefined) {
      throw new MutationNotAllowedError(`${type}.${elementType}`, item.status ?? "", command, []);
    }
    const eg = this.registry.elementGuard(type, elementType);
    const st = item.status ?? "";
    if (eg !== undefined && !eg.can(st, event)) {
      throw new MutationNotAllowedError(`${type}.${elementType}`, st, command, eg.available(st));
    }
  }

  /** Synthesize the op list for a declarative command (target + set + transition + produces). */
  private buildDeclarativeOps(
    view: PageState,
    cmd: DeclarativeCommand,
    args: Record<string, unknown>,
    ctx: ICommandContext,
    elementId: string | undefined,
  ): SectionOp[] {
    if (cmd.produces !== undefined) {
      return cmd.produces(view as DeepReadonly<PageState>, args, ctx);
    }
    const ops: SectionOp[] = [];
    const target = cmd.target;
    if (target !== undefined && cmd.set !== undefined) {
      const sectionKey = target.section;
      const type = view.type;
      if (target.element !== undefined) {
        // setElementField for each `set` entry on the resolved element.
        const id = elementId ?? (args[target.element.idArg] as string);
        const field = target.field ?? this.firstListFieldKey(view, sectionKey);
        const elType = this.elementTypeOf(view, sectionKey, field);
        for (const [elemField, spec] of Object.entries(cmd.set)) {
          const v = this.resolveValueOptional(spec, args, this.elementFieldKind(type, elType, elemField));
          if (v !== undefined) {
            ops.push({ op: "setElementField", section: sectionKey, field, id, elementField: elemField, value: v });
          }
        }
      } else if (target.field !== undefined && this.fieldIsList(view, sectionKey, target.field)) {
        // addElement: build the element fields from `set`.
        const id = ctx.newId();
        const elType = this.elementTypeOf(view, sectionKey, target.field);
        const fields: Record<string, IField> = {};
        for (const [f, spec] of Object.entries(cmd.set)) {
          const v = this.resolveValueOptional(spec, args, this.elementFieldKind(type, elType, f));
          if (v !== undefined) fields[f] = v;
        }
        ops.push({ op: "addElement", section: sectionKey, field: target.field, id, fields });
      } else {
        // setField on a scalar/prose field.
        const field = target.field ?? Object.keys(cmd.set)[0]!;
        const spec = cmd.set[field] ?? Object.values(cmd.set)[0]!;
        const v = this.resolveValueOptional(spec, args, this.registry.fieldDeclOf(type, sectionKey, field)?.kind);
        if (v !== undefined) ops.push({ op: "setField", section: sectionKey, field, value: v });
      }
    }
    if (cmd.transition !== undefined) {
      if (cmd.transition.level === "page") {
        ops.push({ op: "transition", level: "page", event: cmd.transition.event });
      } else if (target !== undefined) {
        const id = elementId ?? (target.element !== undefined ? (args[target.element.idArg] as string) : undefined);
        if (id !== undefined) {
          ops.push({
            op: "transition",
            level: "element",
            section: target.section,
            element: id,
            event: cmd.transition.event,
          });
        }
      }
    }
    return ops;
  }

  private buildGeneratedOps(
    gen: GeneratedCommand,
    args: Record<string, unknown>,
    ctx: ICommandContext,
  ): SectionOp[] {
    switch (gen.kind) {
      case "setField":
        return [{ op: "setField", section: gen.section, field: gen.field, value: this.coerceField(args.value) }];
      case "applyTextEdits": {
        const edits = this.coerceEdits(args.edits);
        const block = gen.onBlocksField ? (args.block as string | undefined) : undefined;
        const expectedHash = typeof args.expectedHash === "string" ? args.expectedHash : undefined;
        return [
          {
            op: "applyTextEdits",
            section: gen.section,
            field: gen.field,
            ...(block !== undefined ? { block: block as never } : {}),
            edits,
            ...(expectedHash !== undefined ? { expectedHash } : {}),
          },
        ];
      }
      case "addElement": {
        const id = (args.id as string) ?? ctx.newId();
        const fields = (args.fields as Record<string, IField>) ?? {};
        return [{ op: "addElement", section: gen.section, field: gen.field, id, fields }];
      }
      case "removeElement":
        return [{ op: "removeElement", section: gen.section, field: gen.field, id: args.id as string }];
      case "moveElement":
        return [{ op: "moveElement", section: gen.section, field: gen.field, id: args.id as string, toIndex: Number(args.toIndex ?? 0) }];
      case "setElementField":
        return [{
          op: "setElementField",
          section: gen.section,
          field: gen.field,
          id: args.id as string,
          elementField: gen.elementField!,
          value: this.coerceField(args.value),
        }];
    }
  }

  private coerceField(value: unknown): IField {
    if (value !== null && typeof value === "object" && "kind" in (value as object)) {
      return normalizeFieldValue(value as IField);
    }
    return { kind: "scalar", value: value as string | number | boolean };
  }

  /** Coerce a raw `edits` arg into a validated `TextEdit[]` (pure shape check). */
  private coerceEdits(value: unknown): TextEdit[] {
    if (!Array.isArray(value)) {
      throw new FieldKindError("applyTextEdits requires an `edits` array of TextEdits.");
    }
    return value.map((e): TextEdit => {
      const r = e as { start?: unknown; end?: unknown; replacement?: unknown };
      if (typeof r.start !== "number" || typeof r.end !== "number" || typeof r.replacement !== "string") {
        throw new FieldKindError("Each TextEdit needs numeric start/end and a string replacement.");
      }
      return { start: r.start, end: r.end, replacement: r.replacement };
    });
  }

  private resolveValueOptional(
    spec: FieldValueSpec,
    args: Record<string, unknown>,
    declKind: string | undefined,
  ): IField | undefined {
    if ("literal" in spec) return normalizeFieldValue(spec.literal);
    const raw = args[spec.__arg];
    if (raw === undefined) return undefined;
    return this.kindFor(declKind, raw);
  }

  /** Build a typed `IField` for `raw` honoring the declared field-kind. */
  private kindFor(declKind: string | undefined, raw: unknown): IField {
    switch (declKind) {
      case "scalar":
        return { kind: "scalar", value: raw as string | number | boolean };
      case "prose":
        return { kind: "prose", value: String(raw) };
      case "code":
        return { kind: "code", lang: "text", source: String(raw), hash: contentHash(String(raw)) };
      default:
        if (typeof raw === "number" || typeof raw === "boolean") return { kind: "scalar", value: raw };
        return { kind: "prose", value: String(raw) };
    }
  }

  private elementTypeOf(view: PageState, sectionKey: string, field: string): string | undefined {
    const sec = view.sections.find((s) => s.key === sectionKey);
    const f = sec?.fields[field];
    if (f !== undefined && f.kind === "list") return f.elementType;
    return undefined;
  }

  private elementFieldKind(type: string, elementType: string | undefined, fieldKey: string): string | undefined {
    if (elementType === undefined) return undefined;
    return this.registry.element(type, elementType)?.fields[fieldKey]?.kind;
  }

  private fieldIsList(view: PageState, sectionKey: string, field: string): boolean {
    const sec = view.sections.find((s) => s.key === sectionKey);
    return sec?.fields[field]?.kind === "list";
  }

  private firstListFieldKey(view: PageState, sectionKey: string): string {
    const sec = view.sections.find((s) => s.key === sectionKey);
    if (sec !== undefined) {
      for (const [k, f] of Object.entries(sec.fields)) if (f.kind === "list") return k;
    }
    return "items";
  }

  private runPreconditions(cmd: DeclarativeCommand, view: PageState, related: IRelatedReader): void {
    for (const pre of cmd.preconditions ?? []) {
      const res = pre(view as DeepReadonly<PageState>, related);
      if (res !== true) throw new PreconditionUnmetError(res.unmet);
    }
  }

  /**
   * Enforce the CONTENT-HASH PRECONDITION on every `applyTextEdits` op that carries
   * `expectedHash` (structured-content §5/§11). Evaluated against the CURRENT folded
   * `view` (a code field/block's live source) inside the rebase-retried `decide`
   * window, so an edit computed against now-stale source — e.g. after an OCC rebase
   * advanced the head, or a concurrent writer touched the same field — is rejected
   * with a typed {@link StaleEditError} rather than silently applied. Pure: it only
   * reads the live source and recomputes its hash.
   */
  private assertEditPreconditions(view: PageState, ops: readonly SectionOp[]): void {
    for (const op of ops) {
      if (op.op !== "applyTextEdits" || op.expectedHash === undefined) continue;
      const sec = view.sections.find((s) => s.key === op.section);
      if (sec === undefined) continue; // a missing section surfaces later as SECTION_NOT_FOUND.
      let actualHash: string | undefined;
      if (op.block !== undefined) {
        const f = sec.fields[op.field];
        if (f !== undefined && f.kind === "blocks") {
          const target = f.blocks.find((b: IBlock) => b.id === op.block);
          if (target !== undefined && target.kind === "code") actualHash = target.hash;
        }
      } else {
        const f = sec.fields[op.field];
        if (f !== undefined && f.kind === "code") actualHash = f.hash;
      }
      if (actualHash === undefined) {
        throw new FieldKindError(
          `applyTextEdits targets a code field/block; "${op.section}.${op.field}"${op.block !== undefined ? `#${op.block}` : ""} is not code.`,
        );
      }
      if (actualHash !== op.expectedHash) {
        throw new StaleEditError(op.section, op.field, op.block, op.expectedHash, actualHash);
      }
    }
  }

  /** Dry-run the ops against a clone and validate the resulting sections (§7). */
  private dryRunAndValidate(
    state: IWorkspaceState,
    type: string,
    view: PageState,
    ops: readonly SectionOp[],
  ): void {
    if (ops.length === 0) return;
    const def = this.registry.page(type);
    const clone: PageState = {
      id: view.id,
      type: view.type,
      parentId: view.parentId,
      title: view.title,
      status: view.status,
      sections: structuredClone(view.sections),
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
    applyOps(clone, ops, {
      now: clone.updatedAt,
      def,
      pageNext: (status, ev) => this.registry.pageGuard(type).next(status, ev),
      elementNext: (elType, status, ev) => this.registry.elementGuard(type, elType)?.next(status, ev),
    });
    // Validate against a state whose page node reflects the dry-run sections.
    const node = state.pages.get(view.id);
    if (node === undefined) return;
    const previous = node.sections;
    node.sections = clone.sections;
    try {
      validatePage(state, node, this.registry);
    } finally {
      node.sections = previous;
    }
    void SectionContractError;
    void contentHash;
  }

  private commandResult(cmd: DeclarativeCommand, args: Record<string, unknown>, ops: readonly SectionOp[]): unknown {
    if (cmd.result === undefined) return undefined;
    // A single `<x>Id` result shape is satisfied by a created element/block id, else an echoed arg.
    const schema = cmd.result.toJsonSchema() as { properties?: Record<string, unknown> };
    const props = Object.keys(schema.properties ?? {});
    const key = props.length === 1 && props[0]!.endsWith("Id") ? props[0]! : undefined;
    if (key === undefined) return undefined;
    const addedEl = ops.find((o) => o.op === "addElement");
    if (addedEl !== undefined && addedEl.op === "addElement") return { [key]: addedEl.id };
    const addedBlock = ops.find((o) => o.op === "addBlock");
    if (addedBlock !== undefined && addedBlock.op === "addBlock") return { [key]: addedBlock.block.id };
    if (args[key] !== undefined) return { [key]: args[key] };
    return undefined;
  }

  private generatedResult(gen: GeneratedCommand, ops: readonly SectionOp[]): unknown {
    const added = ops.find((o) => o.op === "addElement");
    if (gen.kind === "addElement" && added !== undefined && added.op === "addElement") {
      return { id: added.id };
    }
    return undefined;
  }

  /** Assemble the read-only {@link ICommandContext} a `produces` is handed. */
  private buildContext(
    state: IWorkspaceState,
    self: PageId,
    actor: string | undefined,
    commandId: string | undefined,
  ): ICommandContext {
    const related: IRelatedReader = {
      self,
      page(id: PageId): DeepReadonly<PageState> | undefined {
        const n = state.pages.get(id);
        if (n === undefined) return undefined;
        return pageStateView(n) as DeepReadonly<PageState>;
      },
      childrenOf(id: PageId | RootId): readonly PageId[] {
        return [...(state.children.get(id) ?? [])];
      },
    };
    return {
      newId: this.services.newId,
      now: this.services.now(),
      ...(actor !== undefined ? { actor } : {}),
      ...(commandId !== undefined ? { commandId } : {}),
      related,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Commit (the only I/O step) + rebase-and-retry
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the pure `decide` against the current folded state, envelope its events,
   * and append them atomically asserting `expectedVersion = state.version`. On a
   * stale-write conflict, fold the new tail forward and re-run `decide` against
   * the fresh state (bounded retries → {@link ConcurrencyError}).
   *
   * Returns a {@link CommitOutcome}: the typed `result` plus the **committed-head
   * version** after the append AND any rebase (§5 step 6, §8.6). An idempotent /
   * zero-event write reports the current head — no append happens, so the token
   * names where the (already-applied or empty) effect sits.
   */
  private async commit(
    projection: BusProjection,
    decide: (state: IWorkspaceState) => { events: DomainEvent[]; result: unknown },
    meta: { actor?: string; commandId?: string; command?: string; defaultPageId?: PageId },
  ): Promise<CommitOutcome> {
    const ws = projection.state.id;

    for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
      // Idempotency: a commandId already represented in history short-circuits
      // BEFORE we guard/decide (the FSM would otherwise reject the replayed
      // command). The original append already produced the effect (BUILD_NOTES §3).
      // The token reflects the CURRENT head, since the effect already landed (§8.6).
      if (meta.commandId !== undefined && this.commandSeen(projection, meta.commandId)) {
        return { result: undefined, committedVersion: projection.state.version };
      }

      // (Re)decide against the freshest folded state every attempt.
      const { events: raw, result } = decide(projection.state);

      const expectedVersion = projection.state.version;

      // Empty decision: nothing to append — current head is the committed head (§8.6).
      if (raw.length === 0) {
        return { result, committedVersion: projection.state.version };
      }

      const envelopes = this.envelope(projection.state, raw, expectedVersion, meta);

      try {
        await this.eventLog.append(ws, envelopes, { expectedVersion });
      } catch (e) {
        if (isStaleAppend(e)) {
          await this.rebase(projection);
          continue;
        }
        throw e;
      }

      // Success — fold our own envelopes in, advance bookkeeping, fan out. The
      // committed head is the post-absorb version (after the append; rebases
      // already advanced it before this attempt).
      this.absorb(projection, envelopes);
      await this.maybeSnapshot(projection);
      return { result, committedVersion: projection.state.version };
    }

    throw new ConcurrencyError(projection.state.version, projection.state.version);
  }

  /** Envelope each lightweight {@link DomainEvent} into a full {@link IEventEnvelope}. */
  private envelope(
    state: IWorkspaceState,
    raw: readonly DomainEvent[],
    expectedVersion: number,
    meta: { actor?: string; commandId?: string; command?: string; defaultPageId?: PageId },
  ): IEventEnvelope[] {
    const ws: WorkspaceId = state.id;
    const eventMeta: IEventMeta = {
      occurredAt: this.services.now(),
      ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
      ...(meta.commandId !== undefined ? { commandId: meta.commandId } : {}),
      ...(meta.command !== undefined ? { command: meta.command } : {}),
    };

    return raw.map((ev, i): IEventEnvelope => {
      // A content event that omits `pageId` defaults to the command's target
      // page; structural/workspace events keep their own (possibly absent) pageId.
      const pageId =
        ev.pageId ?? (isStructuralEvent(ev.type) ? undefined : meta.defaultPageId);
      const env: IEventEnvelope = {
        eventId: this.services.newId(),
        streamId: ws,
        ...(pageId !== undefined ? { pageId } : {}),
        version: expectedVersion + i,
        type: ev.type,
        schemaVersion: this.schemaVersionFor(state, ev, pageId),
        payload: ev.payload,
        meta: eventMeta,
      };
      return env;
    });
  }

  /**
   * Choose a raw event's `schemaVersion`: a CONTENT event (one routed to a page
   * type's `apply`) is stamped with that page type's current `version`; every
   * structural/workspace event uses `0`. The owning page type is resolved from
   * the (possibly not-yet-folded) projection node, or — for `PageCreated`, whose
   * node does not exist yet — from the event payload's `type`. Unknown types fall
   * back to `0` (the reducer's upcaster handles the rest).
   */
  private schemaVersionFor(state: IWorkspaceState, ev: DomainEvent, pageId?: PageId): number {
    // Structural / workspace events (incl. PageCreated, which carries a pageId)
    // are not content events — they never carry a page-type schema version.
    if (isStructuralEvent(ev.type)) return 0;
    const targetPage = ev.pageId ?? pageId;
    if (targetPage === undefined) return 0;
    const pageType: string | undefined = state.pages.get(targetPage)?.type;
    if (pageType === undefined || !this.registry.has(pageType)) return 0;
    return this.registry.page(pageType).version;
  }

  /** Fold our committed envelopes into the projection and fan out. */
  private absorb(projection: BusProjection, envelopes: readonly IEventEnvelope[]): void {
    for (const env of envelopes) {
      applyWorkspace(projection.state, env, this.registry);
      projection.state.version = env.version + 1;
      projection.events.push(env);
      projection.eventsSinceSnapshot += 1;
      this.fanOut(projection, env);
    }
  }

  /** Deliver one event to handle subscribers + the config sink (never throws out). */
  private fanOut(projection: BusProjection, env: IEventEnvelope): void {
    for (const sub of projection.subscribers) {
      try {
        sub(env);
      } catch {
        /* subscribers must not break the write path */
      }
    }
    if (this.config.onEvent !== undefined) {
      try {
        this.config.onEvent(env);
      } catch {
        /* sink must not throw, per contract — guard anyway */
      }
    }
  }

  /** Has any event already in this projection's history carried `commandId`? */
  private commandSeen(projection: BusProjection, commandId: string): boolean {
    for (const env of projection.events) {
      if (env.meta.commandId === commandId) return true;
    }
    return false;
  }

  /** Read the new tail past our cursor, fold it forward, advance the cursor. */
  private async rebase(projection: BusProjection): Promise<void> {
    const ws = projection.state.id;
    const { events: tail, nextCursor } = await this.eventLog.read(ws, projection.cursor);
    for (const env of tail) {
      // Skip anything we've already folded (cursor may be coarse / overlap).
      if (env.version < projection.state.version) continue;
      applyWorkspace(projection.state, env, this.registry);
      projection.state.version = env.version + 1;
      projection.events.push(env);
      projection.eventsSinceSnapshot += 1;
      this.fanOut(projection, env);
    }
    projection.cursor = nextCursor;
  }

  /** Count-based snapshot (best-effort; failures are swallowed). */
  private async maybeSnapshot(projection: BusProjection): Promise<void> {
    if (this.config.snapshotEvery <= 0) return;
    if (projection.eventsSinceSnapshot < this.config.snapshotEvery) return;
    try {
      await writeSnapshot(
        this.eventLog,
        projection.state.id,
        projection.state,
        projection.cursor,
        this.registry.fingerprint(),
      );
      projection.eventsSinceSnapshot = 0;
    } catch {
      /* snapshots are a cache, never the source of truth — ignore failures */
    }
  }
}
