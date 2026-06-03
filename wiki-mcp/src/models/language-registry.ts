/**
 * The runtime LanguageRegistry (structured-content §4, §11; mirrors the ModelRegistry
 * dynamic-import pattern, ADR-M6). In Phase 1 this is a STUB: it loads no analyzers,
 * so the symbol-index projector records only canonical source locations and the
 * name/kind/range columns stay null (§12). The seam Phase 2/3 fill.
 *
 * No parser dependency enters `wiki-mcp` in Phase 1.
 */

/** The narrow per-language analyzer contract (parsers are plugin deps, never here). */
export interface ILanguageAnalyzer {
  readonly lang: string;
  parse(source: string): unknown;
  symbols(source: string): readonly { name: string; kind: string; range: unknown }[];
  references(source: string, name: string): readonly unknown[];
  rename(source: string, name: string, newName: string): { source: string; edits: readonly unknown[] };
}

/** Loader contract: import an analyzer plugin by specifier (Phase 2/3). */
export type AnalyzerLoader = (specifier: string) => Promise<ILanguageAnalyzer>;

export class LanguageRegistry {
  private readonly analyzers = new Map<string, ILanguageAnalyzer>();
  private readonly specifiers = new Map<string, string>();

  constructor(private readonly loader?: AnalyzerLoader) {}

  /** Register a language → analyzer specifier (Phase 1: recorded but never loaded). */
  register(lang: string, specifier: string): void {
    this.specifiers.set(lang, specifier);
  }

  /** Resolve a loaded analyzer for `lang`, or `undefined` (Phase 1: always undefined). */
  get(lang: string): ILanguageAnalyzer | undefined {
    return this.analyzers.get(lang);
  }

  /** Eagerly load a registered analyzer (Phase 2/3). No-op without a loader. */
  async load(lang: string): Promise<ILanguageAnalyzer | undefined> {
    const existing = this.analyzers.get(lang);
    if (existing !== undefined) return existing;
    const specifier = this.specifiers.get(lang);
    if (specifier === undefined || this.loader === undefined) return undefined;
    const analyzer = await this.loader(specifier);
    this.analyzers.set(lang, analyzer);
    return analyzer;
  }

  /** Registered languages (whether or not an analyzer is loaded). */
  languages(): string[] {
    return [...this.specifiers.keys()];
  }
}
