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
  SectionDecl,
} from "../api";
import { UnknownPageTypeError, ValidationError } from "./errors";
import { makeGuard, type Guard } from "./guard";

const KNOWN_KINDS = new Set(["scalar", "prose", "code", "attachment-ref", "ref", "blocks", "list"]);

/** A generated structural command derived from a section/field declaration. */
export interface GeneratedCommand {
  readonly name: string;
  readonly kind: "setField" | "addElement" | "removeElement" | "moveElement" | "setElementField";
  readonly section: string;
  readonly field: string;
  readonly elementType?: string;
  readonly elementField?: string;
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
