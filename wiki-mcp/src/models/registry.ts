/**
 * The live **model registry** (wiki-mcp ADR-M6): the mutable, generation-counted source of
 * the page-type set. It wraps the engine's immutable {@link Registry} and rebuilds it
 * whenever a bundle is loaded / reloaded / unregistered, bumping a **generation** and the
 * **fingerprint** so the runtime can evict hot engine handles and reproject affected
 * workspaces. Loads are hard **replaces** (ADR-M6) — `reload` re-imports a bundle's
 * specifier cache-busted, so edited code takes effect; `unregister` hard-removes it (a
 * workspace with live events of a dropped type then halts).
 */
import { Registry } from "wiki/registry";

import { loadModelBundle, type PageTypeSet } from "./loader.js";

interface Bundle {
  readonly id: string;
  readonly specifier: string;
  readonly pageTypes: PageTypeSet;
}

/** Emitted on every registry change so the runtime can react (evict handles, reproject). */
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

export class ModelRegistry {
  private readonly bundles = new Map<string, Bundle>();
  private readonly onChange: ((e: ModelRegistryEvent) => void) | undefined;
  private gen = 0;
  private cached: Registry | undefined;
  private cacheBust = 0;

  constructor(opts: { onChange?: (e: ModelRegistryEvent) => void } = {}) {
    this.onChange = opts.onChange;
  }

  /** The current immutable engine {@link Registry}, built from every loaded bundle. Memoized per generation. */
  current(): Registry {
    if (this.cached === undefined) {
      this.cached = new Registry(this.bundles.size === 0 ? [] : [...this.bundles.values()].flatMap((b) => [...b.pageTypes]));
    }
    return this.cached;
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
    return this.load(id, existing.specifier);
  }

  /** Hard-unregister a bundle (ADR-M6) — workspaces with live events of its types will halt. */
  unregister(id: string): ModelRegistryEvent {
    if (!this.bundles.delete(id)) throw new Error(`unknown model bundle "${id}"`);
    return this.bump("unregister", id);
  }

  private bump(reason: ModelRegistryEvent["reason"], bundleId: string): ModelRegistryEvent {
    this.gen++;
    this.cached = undefined;
    const event: ModelRegistryEvent = { generation: this.gen, fingerprint: this.fingerprint(), reason, bundleId };
    this.onChange?.(event);
    return event;
  }
}
