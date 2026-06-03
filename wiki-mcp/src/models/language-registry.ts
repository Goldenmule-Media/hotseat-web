/**
 * The runtime LanguageRegistry (structured-content §4, §11; mirrors the ModelRegistry
 * dynamic-import pattern, ADR-M6). It maps a `code` field/block's `lang` tag to a
 * loaded {@link ILanguageAnalyzer}, or returns `undefined` when no analyzer covers
 * that language — in which case the symbol-index projector keeps its canonical-location
 * stub row (the §12 "opaque blob served verbatim" behaviour).
 *
 * Parsers are dependencies of the analyzer plugins, **never** of `wiki` (the engine
 * stays dep-free + deterministic, §4/§13). A built-in TS/JS analyzer is registered
 * synchronously as the default (mirroring the ModelRegistry's in-memory `register`),
 * so `get(lang)` resolves without any dynamic import for the languages it covers;
 * out-of-tree analyzers may still load lazily through {@link load}.
 */

/**
 * A declaration symbol found in canonical source — the unit the symbol index stores.
 * Offsets are 0-based UTF-16 code-unit offsets into the canonical source string (the
 * units `ts.SourceFile` / `String.prototype.slice` use), so a `[defStart, defEnd)`
 * slice of the source is exactly the symbol's defining text. Language-agnostic: `kind`
 * is an analyzer-defined tag (e.g. `function` / `class` / `method`), not engine-owned.
 */
export interface AnalyzerSymbol {
  /** The declared name (the identifier a reference resolves to). */
  readonly name: string;
  /** Analyzer-defined declaration kind (e.g. `function`, `class`, `interface`). */
  readonly kind: string;
  /** 0-based start offset of the declaration in the canonical source. */
  readonly defStart: number;
  /** End offset (exclusive) of the declaration in the canonical source. */
  readonly defEnd: number;
  /** Optional containing-symbol name (e.g. the class a method belongs to). */
  readonly container?: string;
  /** Whether the declaration is exported from the module (best-effort). */
  readonly exported?: boolean;
}

/**
 * An identifier occurrence in canonical source — a textual reference by `name`. These
 * complement the §6.3 structural `ref` cross-reference index: that one walks typed
 * `ref` nodes; this one is the in-source identifier index a rename/where-used reads.
 * Resolution to a specific declaration (across files/types) is Phase 3 — here a
 * reference is keyed by name + offset only.
 */
export interface AnalyzerReference {
  /** The referenced identifier text. */
  readonly name: string;
  /** 0-based start offset of the occurrence in the canonical source. */
  readonly start: number;
  /** End offset (exclusive) of the occurrence in the canonical source. */
  readonly end: number;
}

/** A structured edit an analyzer's `rename` returns (Phase 3 — not applied in Phase 2). */
export interface AnalyzerTextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * Identifies the rename target within a single source unit (Phase 3). Either the
 * declared `name` (the first declaration of that name wins) or a `offset` into the
 * source that lands on an identifier — the offset form disambiguates when several
 * declarations share a name (the analyzer resolves which binding the offset hits).
 */
export type RenameTarget = { readonly name: string } | { readonly offset: number };

/**
 * The result of a host-side `rename` computation (Phase 3). `edits` are the
 * `[start,end)`→`newName` replacements over the ONE source unit, sound for the
 * in-scope lexical references that bind to the SAME declaration (shadowed / unrelated
 * same-name identifiers are excluded). `unresolved` carries human-readable notes for
 * sites the analyzer could not safely rename (e.g. the target name was not found, or a
 * `newName` collision) — reported, never guessed. `oldName` echoes the resolved
 * declaration name so the host can harvest cross-field same-name candidates (§5).
 */
export interface RenameResult {
  readonly oldName: string;
  readonly newName: string;
  readonly edits: readonly AnalyzerTextEdit[];
  readonly unresolved: readonly string[];
}

/**
 * The narrow per-language analyzer contract (structured-content §11; parsers are
 * plugin deps, never here). Every method is **pure and deterministic** — equal source
 * yields equal output — with no wall-clock or RNG, so the projection stays a pure
 * read-model derivation (§10). `parse` exposes the read-model AST; `symbols` /
 * `references` feed the §6.2/§6.3 indexes; `rename` (declared, Phase 3) returns edits
 * the host applies as a guarded `applyTextEdits` — the analyzer never writes.
 */
export interface ILanguageAnalyzer {
  /** Every `lang` tag this analyzer claims (e.g. `["ts","tsx","js","jsx","mjs","cjs"]`). */
  readonly langs: readonly string[];
  /**
   * Parse canonical source into a read-model AST (derived, never stored, §4). The
   * optional `lang` lets a multi-dialect analyzer pick a parse mode (e.g. tsx vs ts);
   * it is one of {@link langs} and defaults to the analyzer's primary dialect.
   */
  parse(source: string, lang?: string): unknown;
  /** Declarations found in `source`, as offset-ranged {@link AnalyzerSymbol}s. */
  symbols(source: string, lang?: string): readonly AnalyzerSymbol[];
  /** Identifier occurrences in `source` (optionally only those named `name`). */
  references(source: string, name?: string, lang?: string): readonly AnalyzerReference[];
  /**
   * Compute TYPE-AWARE rename edits host-side (Phase 3) over the ONE source unit —
   * returns, never writes. Resolves `target` to its declaration via a single-file
   * type-checker so only occurrences that BIND to that declaration are renamed
   * (shadowed / unrelated same-name identifiers are left alone). Optional: a Phase-2
   * analyzer may omit it.
   */
  rename?(source: string, target: RenameTarget, newName: string, lang?: string): RenameResult;
}

/** Loader contract: import an analyzer plugin by specifier (for out-of-tree analyzers). */
export type AnalyzerLoader = (specifier: string) => Promise<ILanguageAnalyzer>;

export class LanguageRegistry {
  /** Lang tag → loaded analyzer. Many tags may map to one analyzer (ts/tsx/js/…). */
  private readonly analyzers = new Map<string, ILanguageAnalyzer>();
  /** Lang tag → module specifier, for analyzers that load lazily via {@link load}. */
  private readonly specifiers = new Map<string, string>();

  constructor(private readonly loader?: AnalyzerLoader) {}

  /**
   * Register a loaded analyzer synchronously for every `lang` it claims (the built-in
   * path, mirroring the ModelRegistry's in-memory `register`). `get(lang)` then
   * resolves without a dynamic import.
   */
  registerAnalyzer(analyzer: ILanguageAnalyzer): void {
    for (const lang of analyzer.langs) this.analyzers.set(lang.toLowerCase(), analyzer);
  }

  /** Register a `lang` → analyzer specifier for lazy loading via {@link load} (out-of-tree). */
  register(lang: string, specifier: string): void {
    this.specifiers.set(lang.toLowerCase(), specifier);
  }

  /** Resolve a loaded analyzer for `lang`, or `undefined` if none is registered/loaded. */
  get(lang: string): ILanguageAnalyzer | undefined {
    return this.analyzers.get(lang.toLowerCase());
  }

  /** Eagerly load a registered (lazy) analyzer specifier. No-op without a loader. */
  async load(lang: string): Promise<ILanguageAnalyzer | undefined> {
    const key = lang.toLowerCase();
    const existing = this.analyzers.get(key);
    if (existing !== undefined) return existing;
    const specifier = this.specifiers.get(key);
    if (specifier === undefined || this.loader === undefined) return undefined;
    const analyzer = await this.loader(specifier);
    this.registerAnalyzer(analyzer);
    return analyzer;
  }

  /** Registered languages (loaded analyzers + lazy specifiers). */
  languages(): string[] {
    return [...new Set([...this.analyzers.keys(), ...this.specifiers.keys()])];
  }
}
