/**
 * Page-type Registry (structured-content §6, §9). Built from the wiki config's
 * `pageTypes`. Validates declarations mechanically, memoizes page/element FSM
 * guards, derives the generated structural command set, and produces a stable
 * `fingerprint()` for snapshot invalidation. Pure: no I/O, no host clock/RNG.
 */
import type {
  DeclarativeCommand,
  ElementDecl,
  FieldDecl,
  IPageType,
  IPageTypeDef,
  ITransition,
  SectionDecl,
} from "../api";
import { UnknownPageTypeError, ValidationError } from "./errors";
import { makeGuard, type Guard } from "./guard";

const KNOWN_KINDS = new Set(["scalar", "prose", "code", "attachment-ref", "ref", "blocks", "list", "serial"]);

/** A generated structural command derived from a section/field declaration. */
export interface GeneratedCommand {
  readonly name: string;
  readonly kind:
    | "setField"
    | "applyTextEdits"
    | "addElement"
    | "removeElement"
    | "moveElement"
    | "setElementField";
  readonly section: string;
  readonly field: string;
  readonly elementType?: string;
  readonly elementField?: string;
  /**
   * For an `applyTextEdits` command: whether the target field is a `blocks` field
   * (so a `block` id arg is required to address a `code` block) vs a `code` field
   * (the field IS the code, no block). Undefined for non-edit kinds.
   */
  readonly onBlocksField?: boolean;
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export class Registry {
  private readonly pages = new Map<string, IPageTypeDef>();
  /** page-type → element-type → decl (gathered from `elements`). */
  private readonly elements = new Map<string, Map<string, ElementDecl>>();
  private readonly pageGuards = new Map<string, Guard<string, string>>();
  /** element-type guard, keyed by `${pageType}:${elementType}`. */
  private readonly elementGuards = new Map<string, Guard<string, string> | undefined>();
  /** generated commands keyed by page type → command name. */
  private readonly generated = new Map<string, Map<string, GeneratedCommand>>();

  constructor(pageTypes: readonly IPageType[]) {
    for (const pt of pageTypes) {
      const def = pt.__def;
      this.validateDef(def);
      this.pages.set(def.type, def);
      const elMap = new Map<string, ElementDecl>();
      for (const [tag, el] of Object.entries(def.elements ?? {})) elMap.set(tag, el);
      this.elements.set(def.type, elMap);
      this.generated.set(def.type, this.deriveGenerated(def));
    }
  }

  // ── declaration validation (§6/§9.6) ──────────────────────────────────────

  private validateDef(def: IPageTypeDef): void {
    const issues: { path: (string | number)[]; message: string }[] = [];
    if (def.label !== undefined && (typeof def.label !== "string" || def.label.length === 0)) {
      issues.push({ path: ["label"], message: "label, when present, must be a non-empty string" });
    }
    const statuses = new Set<string>([def.initialStatus]);
    for (const tr of def.statusTransitions) {
      statuses.add(tr.fromState);
      statuses.add(tr.toState);
    }
    const elementTypes = new Set(Object.keys(def.elements ?? {}));
    const validateSectionDecl = (key: string, sd: SectionDecl): void => {
      for (const [fk, fd] of Object.entries(sd.fields)) {
        if (!KNOWN_KINDS.has(fd.kind)) {
          issues.push({ path: ["sections", key, "fields", fk], message: `unknown field-kind "${fd.kind}"` });
        }
        if (fd.kind === "list" && !elementTypes.has((fd as { element: string }).element)) {
          issues.push({ path: ["sections", key, "fields", fk], message: `list element "${(fd as { element: string }).element}" is not a declared element type` });
        }
      }
      for (const status of sd.mutableIn ?? []) {
        if (!statuses.has(status)) {
          issues.push({ path: ["sections", key, "mutableIn"], message: `references unknown status "${status}"` });
        }
      }
      for (const [nk, nested] of Object.entries(sd.sections ?? {})) validateSectionDecl(nk, nested);
    };
    for (const [key, sd] of Object.entries(def.sections)) validateSectionDecl(key, sd);

    // ── static reachability guards (§6; feature-review Item 5) ────────────────
    // Turn whole classes of silent, load-after deadlocks into load-time errors.
    const reachableFrom = (initial: string, transitions: readonly ITransition[]): Set<string> => {
      const seen = new Set<string>([initial]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const tr of transitions) {
          if (seen.has(tr.fromState) && !seen.has(tr.toState)) {
            seen.add(tr.toState);
            changed = true;
          }
        }
      }
      return seen;
    };

    // (1) A write-gate that names a status UNREACHABLE from the initial status is a
    // dead gate (the section can never be edited in it); a REQUIRED section frozen in
    // every status (`mutableIn: []`) is materialized empty and can never be filled.
    const reachableStatuses = reachableFrom(def.initialStatus, def.statusTransitions);
    const lintGate = (key: string, sd: SectionDecl): void => {
      if (sd.mutableIn !== undefined) {
        for (const status of sd.mutableIn) {
          if (statuses.has(status) && !reachableStatuses.has(status)) {
            issues.push({ path: ["sections", key, "mutableIn"], message: `status "${status}" is unreachable from the initial status "${def.initialStatus}" — a dead write-gate` });
          }
        }
        if (sd.mutableIn.length === 0 && sd.required === true) {
          issues.push({ path: ["sections", key, "mutableIn"], message: `a required section that is never mutable (mutableIn: []) is materialized empty and can never be filled` });
        }
      }
      for (const [nk, nested] of Object.entries(sd.sections ?? {})) lintGate(nk, nested);
    };
    for (const [key, sd] of Object.entries(def.sections)) lintGate(key, sd);

    // (2) An element-FSM state mentioned by a transition but unreachable from the
    // element's initial status can never be entered — and any gate keyed on it (e.g. a
    // ship gate requiring every case `passed`) would be unsatisfiable.
    for (const [tag, el] of Object.entries(def.elements ?? {})) {
      const fsm = el.status;
      if (fsm === undefined) continue;
      const elReach = reachableFrom(fsm.initial, fsm.transitions);
      const mentioned = new Set<string>([fsm.initial]);
      for (const tr of fsm.transitions) {
        mentioned.add(tr.fromState);
        mentioned.add(tr.toState);
      }
      for (const s of mentioned) {
        if (!elReach.has(s)) {
          issues.push({ path: ["elements", tag, "status"], message: `element status "${s}" is unreachable from the initial status "${fsm.initial}"` });
        }
      }
    }

    // sectionSet contract keys resolve.
    const sectionKeys = new Set(Object.keys(def.sections));
    if (def.sectionSet !== undefined) {
      for (const p of def.sectionSet.prohibited ?? []) {
        // prohibited may reference keys not in the declared set — that is allowed.
        void p;
      }
      for (const ck of Object.keys(def.sectionSet.cardinality ?? {})) {
        if (!sectionKeys.has(ck)) {
          issues.push({ path: ["sectionSet", "cardinality", ck], message: `references undeclared section "${ck}"` });
        }
      }
    }
    if (issues.length > 0) {
      throw new ValidationError(`Invalid page type "${def.type}".`, issues);
    }
  }

  // ── generated command derivation (§9.4 / §9.8) ────────────────────────────

  private deriveGenerated(def: IPageTypeDef): Map<string, GeneratedCommand> {
    const out = new Map<string, GeneratedCommand>();
    const walk = (key: string, sd: SectionDecl): void => {
      for (const [fk, fd] of Object.entries(sd.fields)) {
        // `serial` is engine-assigned and immutable — generate no setter for it, so it has
        // no write path on the command surface (the value is minted once at createPage).
        if (fd.kind === "serial") continue;
        if (fd.kind === "list") {
          const elType = (fd as { element: string }).element;
          const elDecl = (def.elements ?? {})[elType];
          const addName = `add${cap(key)}${cap(fk)}Element`;
          out.set(addName, { name: addName, kind: "addElement", section: key, field: fk, elementType: elType });
          const removeName = `remove${cap(key)}${cap(fk)}Element`;
          out.set(removeName, { name: removeName, kind: "removeElement", section: key, field: fk, elementType: elType });
          const moveName = `move${cap(key)}${cap(fk)}Element`;
          out.set(moveName, { name: moveName, kind: "moveElement", section: key, field: fk, elementType: elType });
          for (const efk of Object.keys(elDecl?.fields ?? {})) {
            const setEl = `set${cap(key)}${cap(fk)}${cap(efk)}`;
            out.set(setEl, { name: setEl, kind: "setElementField", section: key, field: fk, elementType: elType, elementField: efk });
          }
        } else {
          const setName = `set${cap(key)}${cap(fk)}`;
          out.set(setName, { name: setName, kind: "setField", section: key, field: fk });
          // A `code` field also gets a guarded code-edit command: it applies a
          // precomputed `TextEdit[]` under a content-hash precondition (§5/§11). The
          // host (wiki-mcp) computes the edits (rename, etc.) and calls this command.
          if (fd.kind === "code") {
            const editName = `apply${cap(key)}${cap(fk)}Edits`;
            out.set(editName, { name: editName, kind: "applyTextEdits", section: key, field: fk });
          }
          // A `blocks` field may hold `code` blocks — the same guarded code-edit
          // command, addressing one block by id (§3.1: a code block IS a code field).
          if (fd.kind === "blocks") {
            const editName = `apply${cap(key)}${cap(fk)}BlockEdits`;
            out.set(editName, {
              name: editName,
              kind: "applyTextEdits",
              section: key,
              field: fk,
              onBlocksField: true,
            });
          }
        }
      }
      for (const [nk, nested] of Object.entries(sd.sections ?? {})) walk(nk, nested);
    };
    for (const [key, sd] of Object.entries(def.sections)) walk(key, sd);
    return out;
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  page(type: string): IPageTypeDef {
    const def = this.pages.get(type);
    if (def === undefined) throw new UnknownPageTypeError([type]);
    return def;
  }

  /** Every registered page-type tag, in declaration order. */
  types(): readonly string[] {
    return [...this.pages.keys()];
  }

  has(type: string): boolean {
    return this.pages.has(type);
  }

  pageGuard(type: string): Guard<string, string> {
    const cached = this.pageGuards.get(type);
    if (cached !== undefined) return cached;
    const def = this.page(type);
    const guard = makeGuard<string, string>(def.statusTransitions);
    this.pageGuards.set(type, guard);
    return guard;
  }

  /** The element decl for `(pageType, elementType)`, or undefined. */
  element(pageType: string, elementType: string): ElementDecl | undefined {
    return this.elements.get(pageType)?.get(elementType);
  }

  /** Memoized element FSM guard, or undefined when the element type has no FSM. */
  elementGuard(pageType: string, elementType: string): Guard<string, string> | undefined {
    const key = `${pageType}:${elementType}`;
    if (this.elementGuards.has(key)) return this.elementGuards.get(key);
    const decl = this.element(pageType, elementType);
    const transitions = decl?.status?.transitions;
    const guard = transitions === undefined ? undefined : makeGuard<string, string>(transitions);
    this.elementGuards.set(key, guard);
    return guard;
  }

  /** Generated structural commands for a page type, keyed by name. */
  generatedCommands(pageType: string): ReadonlyMap<string, GeneratedCommand> {
    return this.generated.get(pageType) ?? new Map();
  }

  /** Declared keys + decls of required sections (materialized empty at create). */
  requiredSectionsOf(type: string): { key: string; decl: SectionDecl }[] {
    const def = this.pages.get(type);
    if (def === undefined) return [];
    const out: { key: string; decl: SectionDecl }[] = [];
    for (const [key, sd] of Object.entries(def.sections)) {
      if (sd.required === true) out.push({ key, decl: sd });
    }
    return out;
  }

  /** All declared section keys for a type (top-level). */
  sectionDeclsOf(type: string): Readonly<Record<string, SectionDecl>> {
    return this.pages.get(type)?.sections ?? {};
  }

  fieldDeclOf(type: string, sectionKey: string, fieldKey: string): FieldDecl | undefined {
    return this.pages.get(type)?.sections[sectionKey]?.fields[fieldKey];
  }

  commandDef(type: string, name: string): DeclarativeCommand | undefined {
    return this.pages.get(type)?.commands[name];
  }

  fingerprint(): string {
    return [...this.pages.values()]
      .map((def) => `${def.type}@${def.version}`)
      .sort()
      .join(",");
  }
}
