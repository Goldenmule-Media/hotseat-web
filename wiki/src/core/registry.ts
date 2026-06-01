/**
 * Page/item type Registry (BUILD_NOTES §8, DESIGN §6.3/§6.4).
 *
 * Built from the wiki config's `pageTypes`. Resolves page type defs, gathers the
 * item type defs declared across all page defs, and memoizes FSM guards over the
 * declared `statusTransitions`. Also produces a stable `fingerprint()` used to
 * invalidate snapshots when any page type's schema version changes.
 *
 * Pure: no I/O, no host clock/RNG.
 */
import type { IItemTypeDef, IPageType, IPageTypeDef } from "../api";
import { UnknownPageTypeError } from "./errors";
import { makeGuard, type Guard } from "./guard";

export class Registry {
  /** page-type tag → def. */
  private readonly pages = new Map<string, IPageTypeDef>();
  /** item-type tag → def, gathered from every page def's `items` map. */
  private readonly items = new Map<string, IItemTypeDef<string>>();
  /** Memoized page-lifecycle guards, keyed by page-type tag. */
  private readonly pageGuards = new Map<string, Guard<string, string>>();
  /** Memoized item-lifecycle guards, keyed by item-type tag (undefined when no FSM). */
  private readonly itemGuards = new Map<string, Guard<string, string> | undefined>();
  /** item-type tags declared by each page type, keyed by page-type tag. */
  private readonly itemTagsByPage = new Map<string, string[]>();

  constructor(pageTypes: readonly IPageType<any, any, any, any>[]) {
    for (const pt of pageTypes) {
      const def = pt.__def;
      this.pages.set(def.type, def);
      const tags: string[] = [];
      const itemsMap = def.items ?? {};
      for (const [tag, itemType] of Object.entries(itemsMap)) {
        tags.push(tag);
        // First declaration wins; item type defs are expected to be consistent.
        if (!this.items.has(tag)) this.items.set(tag, itemType.__def);
      }
      this.itemTagsByPage.set(def.type, tags);
    }
  }

  /** Resolve a page type def, or throw {@link UnknownPageTypeError}. */
  page(type: string): IPageTypeDef {
    const def = this.pages.get(type);
    if (def === undefined) throw new UnknownPageTypeError([type]);
    return def;
  }

  /** Whether `type` is a registered page type. */
  has(type: string): boolean {
    return this.pages.has(type);
  }

  /** Memoized FSM guard over a page type's `statusTransitions`. */
  pageGuard(type: string): Guard<string, string> {
    const cached = this.pageGuards.get(type);
    if (cached !== undefined) return cached;
    const def = this.page(type);
    const guard = makeGuard<string, string>(def.statusTransitions);
    this.pageGuards.set(type, guard);
    return guard;
  }

  /** Resolve an item type def by tag (gathered across all page defs), or undefined. */
  item(tag: string): IItemTypeDef<string> | undefined {
    return this.items.get(tag);
  }

  /**
   * Memoized FSM guard over an item type's `statusTransitions`, or undefined when
   * the item type has no FSM (no `statusTransitions`) or the tag is unknown.
   */
  itemGuard(tag: string): Guard<string, string> | undefined {
    if (this.itemGuards.has(tag)) return this.itemGuards.get(tag);
    const def = this.items.get(tag);
    const transitions = def?.statusTransitions;
    const guard =
      transitions === undefined ? undefined : makeGuard<string, string>(transitions);
    this.itemGuards.set(tag, guard);
    return guard;
  }

  /** The item-type tags a page type declares (empty array if none / unknown). */
  itemTypesOf(pageType: string): string[] {
    return [...(this.itemTagsByPage.get(pageType) ?? [])];
  }

  /**
   * Stable `"type@version,..."` string, sorted by type, for snapshot invalidation.
   * Changing any page type's `version` changes the fingerprint, forcing a re-fold.
   */
  fingerprint(): string {
    return [...this.pages.values()]
      .map((def) => `${def.type}@${def.version}`)
      .sort()
      .join(",");
  }
}
