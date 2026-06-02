/**
 * The live **model registry** (wiki-mcp ADR-M6): the mutable, generation-counted source of
 * the page-type set. It wraps the engine's immutable {@link Registry} and rebuilds it
 * whenever a bundle is loaded / reloaded / unregistered, bumping a **generation** and the
 * **fingerprint** and notifying {@link onChange} so the runtime can rebind the engine and
 * reproject affected workspaces. Loads are hard **replaces** (ADR-M6) — `reload` re-imports
 * a bundle's specifier cache-busted, so edited code takes effect; `unregister` hard-removes
 * it (a workspace with live events of a dropped type then halts).
 */
import { Registry } from "wiki/registry";

import { loadModelBundle, type PageTypeSet } from "./loader.js";

interface Bundle {
  readonly id: string;
  readonly specifier: string;
  readonly pageTypes: PageTypeSet;
}

/** Emitted (and AWAITED) on every registry change so the runtime can rebind + reproject. */
export interface ModelRegistryEvent {
  readonly generation: number;
  readonly fingerprint: string;
  readonly reason: "load" | "reload" | "unregister";
  readonly bundleId: string;
}

/** A loaded bundle as seen by the control surface (`GET /_server/models`). */
export interface BundleInfo {
  readonly id: string;
  readonly specifier: string;
  readonly types: string[];
}

/** Specifier stamped on a bundle registered from already-loaded defs (no import to reload). */
const IN_MEMORY = "<in-memory>";

export class ModelRegistry {
  private readonly bundles = new Map<string, Bundle>();
  private gen = 0;
  private cached: Registry | undefined;
  private cacheBust = 0;
  /**
   * Notified (awaited) on every change so the runtime can rebind the engine + reproject.
   * Settable AFTER construction so a host can seed the initial bundle BEFORE wiring the
   * reaction — a seed must not trigger a reproject (the engine/projection don't exist yet).
   */
  onChange: ((e: ModelRegistryEvent) => void | Promise<void>) | undefined;

  constructor(opts: { onChange?: (e: ModelRegistryEvent) => void | Promise<void> } = {}) {
    this.onChange = opts.onChange;
  }

  /** The current immutable engine {@link Registry}, built from every loaded bundle. Memoized per generation. */
  current(): Registry {
    if (this.cached === undefined) this.cached = new Registry(this.pageTypes());
    return this.cached;
  }

  /** The flattened page-type defs across every loaded bundle (what the engine consumes). */
  pageTypes(): PageTypeSet {
    if (this.bundles.size === 0) return [];
    return [...this.bundles.values()].flatMap((b) => [...b.pageTypes]);
  }

  generation(): number {
    return this.gen;
  }

  fingerprint(): string {
    return this.current().fingerprint();
  }

  list(): BundleInfo[] {
    return [...this.bundles.values()].map((b) => ({
      id: b.id,
      specifier: b.specifier,
      types: b.pageTypes.map((p) => (p as { __def: { type: string } }).__def.type),
    }));
  }

  /** Register a bundle from already-loaded defs (the initial/static set; no import). */
  register(id: string, pageTypes: PageTypeSet): Promise<ModelRegistryEvent> {
    const reason = this.bundles.has(id) ? "reload" : "load";
    this.bundles.set(id, { id, specifier: IN_MEMORY, pageTypes });
    return this.bump(reason, id);
  }

  /** Load (or hard-replace) a bundle `id` from its `specifier`, cache-busted, then bump the generation. */
  async load(id: string, specifier: string): Promise<ModelRegistryEvent> {
    const reason = this.bundles.has(id) ? "reload" : "load";
    const { pageTypes } = await loadModelBundle(specifier, String(this.cacheBust++));
    this.bundles.set(id, { id, specifier, pageTypes });
    return this.bump(reason, id);
  }

  /** Reload a bundle already known by `id` — re-import its specifier (cache-busted) so edited code takes effect. */
  async reload(id: string): Promise<ModelRegistryEvent> {
    const existing = this.bundles.get(id);
    if (existing === undefined) throw new Error(`unknown model bundle "${id}"`);
    if (existing.specifier === IN_MEMORY) {
      throw new Error(`bundle "${id}" was registered in-memory and has no specifier to reload`);
    }
    return this.load(id, existing.specifier);
  }

  /** Hard-unregister a bundle (ADR-M6) — workspaces with live events of its types will halt. */
  async unregister(id: string): Promise<ModelRegistryEvent> {
    if (!this.bundles.delete(id)) throw new Error(`unknown model bundle "${id}"`);
    return this.bump("unregister", id);
  }

  private async bump(reason: ModelRegistryEvent["reason"], bundleId: string): Promise<ModelRegistryEvent> {
    this.gen++;
    this.cached = undefined;
    const event: ModelRegistryEvent = { generation: this.gen, fingerprint: this.fingerprint(), reason, bundleId };
    await this.onChange?.(event);
    return event;
  }
}
