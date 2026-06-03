/**
 * The built-in TypeScript / JavaScript analyzer (structured-content §11, wiki-mcp §6.2).
 *
 * A pure, deterministic symbol/reference indexer over canonical `code` source, built on
 * the **`typescript` compiler API** — `ts.createSourceFile` + a single deterministic
 * AST walk. It needs **no `Program` and no type-checker**: a symbol *index* and a
 * by-name *reference* index are syntactic, so a lone `SourceFile` parse suffices (and
 * keeps it cheap, side-effect-free, and version-pinned to the installed `typescript`).
 *
 * Determinism (§10): the only inputs are the source string and the constant
 * `ScriptTarget`/`ScriptKind` we pick from `lang`; no wall-clock, no RNG, no filesystem.
 * Offsets are 0-based UTF-16 code-unit offsets into the canonical source (the units
 * `ts.Node` positions and `String.slice` share), so a `[defStart, defEnd)` slice is the
 * declaration's verbatim text. Cross-file / type-aware resolution (which `bar` a
 * reference binds to) is **Phase 3** — here references are keyed by name + offset.
 *
 * `typescript` is a host dependency of `wiki-mcp` and stays EXTERNAL in the tsdown
 * build (never bundled); `wiki` never sees it (§4/§13).
 */
import ts from "typescript";

import type {
  AnalyzerReference,
  AnalyzerSymbol,
  AnalyzerTextEdit,
  ILanguageAnalyzer,
  RenameResult,
  RenameTarget,
} from "../language-registry.js";

/** The `lang` tags this analyzer claims (lower-cased; the registry keys on these). */
const LANGS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "typescript", "javascript"] as const;

/** Pick a deterministic `ScriptKind` from the `lang` tag (defaults to TS/TSX). */
function scriptKind(lang: string): ts.ScriptKind {
  switch (lang.toLowerCase()) {
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "js":
    case "mjs":
    case "cjs":
    case "javascript":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/** Parse `source` into a `SourceFile` with parent pointers (needed for `getStart`). */
function sourceFileFor(source: string, lang: string): ts.SourceFile {
  return ts.createSourceFile(
    `code.${lang}`,
    source,
    // A fixed, modern target — deterministic and independent of any tsconfig.
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind(lang),
  );
}

/** True if `mods` contains the `export` modifier (best-effort `exported` flag). */
function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Map a binding-name node to its identifier text, or `undefined` for a pattern. */
function bindingName(name: ts.BindingName | undefined): string | undefined {
  if (name !== undefined && ts.isIdentifier(name)) return name.text;
  return undefined;
}

/** The virtual filename a single-source Program parses (deterministic). */
function virtualFileName(lang: string): string {
  return `code.${lang.toLowerCase()}`;
}

/**
 * Build a SINGLE-FILE `ts.Program` + type-checker over `source` (structured-content
 * §5/§11/§12). No filesystem, no tsconfig, no lib resolution — a fixed in-memory host
 * serving exactly one file, with `noResolve` + `noLib` so the build is deterministic,
 * cheap, and independent of the runtime's `typescript` lib layout. The checker resolves
 * which DECLARATION an identifier binds to WITHIN this one source unit (so a shadowing
 * binding is a distinct symbol), which is what a sound rename needs. Cross-file /
 * multi-source resolution is deferred (one source unit per call for v1).
 */
function singleFileProgram(source: string, lang: string): { program: ts.Program; sourceFile: ts.SourceFile } {
  const fileName = virtualFileName(lang);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    checkJs: false,
    noResolve: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
    isolatedModules: false,
  };
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(lang));
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  };
  const program = ts.createProgram([fileName], options, host);
  // Re-fetch the SourceFile the program actually bound (so symbols resolve against it).
  const bound = program.getSourceFile(fileName) ?? sourceFile;
  return { program, sourceFile: bound };
}

/** Canonicalize a symbol through aliases so a rename compares stable declaration identity. */
function canonicalSymbol(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (sym === undefined) return undefined;
  if ((sym.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(sym);
    } catch {
      return sym;
    }
  }
  return sym;
}

/**
 * The TS/JS analyzer instance — stateless, so a single shared instance is reused for
 * every projection (pure functions of their `source` argument).
 */
class TypeScriptAnalyzer implements ILanguageAnalyzer {
  readonly langs = LANGS;

  parse(source: string, lang = "ts"): unknown {
    // The read-model AST (derived, never stored §4) — parsed with the lang's script kind.
    return sourceFileFor(source, lang);
  }

  symbols(source: string, lang = "ts"): readonly AnalyzerSymbol[] {
    const sf = sourceFileFor(source, lang);
    const out: AnalyzerSymbol[] = [];

    const push = (
      name: string | undefined,
      kind: string,
      node: ts.Node,
      container: string | undefined,
    ): void => {
      if (name === undefined || name.length === 0) return;
      const sym: AnalyzerSymbol = {
        name,
        kind,
        defStart: node.getStart(sf),
        defEnd: node.getEnd(),
        exported: isExported(node),
        ...(container !== undefined ? { container } : {}),
      };
      out.push(sym);
    };

    // A single recursive descent. `container` is the enclosing class/interface name so a
    // method/property carries its owner (best-effort, no resolution). The walk visits
    // children in source order, so the symbol list is deterministic.
    const visit = (node: ts.Node, container: string | undefined): void => {
      if (ts.isFunctionDeclaration(node)) {
        push(node.name?.text, "function", node, container);
      } else if (ts.isClassDeclaration(node)) {
        const nm = node.name?.text;
        push(nm, "class", node, container);
        // Recurse class members under the class name as the container.
        for (const m of node.members) visit(m, nm ?? container);
        return;
      } else if (ts.isInterfaceDeclaration(node)) {
        const nm = node.name.text;
        push(nm, "interface", node, container);
        for (const m of node.members) visit(m, nm);
        return;
      } else if (ts.isTypeAliasDeclaration(node)) {
        push(node.name.text, "type", node, container);
      } else if (ts.isEnumDeclaration(node)) {
        const nm = node.name.text;
        push(nm, "enum", node, container);
        for (const m of node.members) {
          if (ts.isIdentifier(m.name)) push(m.name.text, "enum-member", m, nm);
        }
        return;
      } else if (ts.isModuleDeclaration(node)) {
        if (ts.isIdentifier(node.name)) push(node.name.text, "namespace", node, container);
      } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        if (ts.isIdentifier(node.name)) push(node.name.text, "method", node, container);
      } else if (
        (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
        ts.isIdentifier(node.name)
      ) {
        push(node.name.text, "property", node, container);
      } else if (
        (ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
        ts.isIdentifier(node.name)
      ) {
        push(node.name.text, ts.isGetAccessor(node) ? "getter" : "setter", node, container);
      } else if (ts.isVariableStatement(node)) {
        // top-level / block-scoped const|let|var → one symbol per simple binding.
        const kw =
          (node.declarationList.flags & ts.NodeFlags.Const) !== 0
            ? "const"
            : (node.declarationList.flags & ts.NodeFlags.Let) !== 0
              ? "let"
              : "var";
        for (const decl of node.declarationList.declarations) {
          push(bindingName(decl.name), kw, decl, container);
        }
      }

      node.forEachChild((child) => visit(child, container));
    };

    visit(sf, undefined);
    return out;
  }

  references(source: string, name?: string, lang = "ts"): readonly AnalyzerReference[] {
    const sf = sourceFileFor(source, lang);
    const out: AnalyzerReference[] = [];

    // Every `Identifier` occurrence is a reference-by-name. Property/binding names are
    // included (a rename's where-used set wants them); resolution to a binding is Phase 3.
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const text = node.text;
        if (name === undefined || text === name) {
          out.push({ name: text, start: node.getStart(sf), end: node.getEnd() });
        }
      }
      node.forEachChild(visit);
    };

    visit(sf);
    return out;
  }

  /**
   * TYPE-AWARE single-source rename (structured-content §5/§11, Phase 3). Builds a
   * single-file `ts.Program` + checker, resolves `target` to its declaration symbol,
   * then renames EXACTLY the identifier occurrences that bind to that same symbol —
   * so a SHADOWING inner binding of the same name, and an unrelated same-name symbol,
   * are left untouched. Returns the `[start,end)`→`newName` edits plus any `unresolved`
   * notes (target not found, `newName` collides with an existing binding). Deterministic
   * and pure: the only inputs are `source`, `target`, `newName`, and the constant
   * compiler options; no wall-clock, RNG, or filesystem. The analyzer NEVER writes —
   * the host applies these edits via a guarded `applyTextEdits` (engine §5).
   */
  rename(source: string, target: RenameTarget, newName: string, lang = "ts"): RenameResult {
    const { program, sourceFile } = singleFileProgram(source, lang);
    const checker = program.getTypeChecker();
    const unresolved: string[] = [];

    // 1. Locate the target identifier node (by offset, or first declaration by name).
    const targetIdent = "offset" in target
      ? identifierAt(sourceFile, target.offset)
      : firstDeclarationIdentifier(sourceFile, target.name);
    if (targetIdent === undefined) {
      const label = "offset" in target ? `offset ${target.offset}` : `"${target.name}"`;
      return { oldName: "name" in target ? target.name : "", newName, edits: [], unresolved: [`Target ${label} did not resolve to a renameable identifier.`] };
    }
    const oldName = targetIdent.text;

    // 2. Resolve the target's declaration symbol (canonicalized through aliases).
    const targetSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(targetIdent));
    if (targetSymbol === undefined) {
      return { oldName, newName, edits: [], unresolved: [`Could not resolve a declaration symbol for "${oldName}".`] };
    }

    // 3. Collect every identifier with text === oldName whose symbol matches the target.
    //    A shadowing binding resolves to a DIFFERENT symbol, so it is excluded.
    const edits: AnalyzerTextEdit[] = [];
    let sawShadowed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === oldName) {
        const sym = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
        if (sym !== undefined && sym === targetSymbol) {
          edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), replacement: newName });
        } else if (sym !== undefined) {
          sawShadowed = true;
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);

    if (edits.length === 0) {
      unresolved.push(`No bound occurrences of "${oldName}" were found to rename.`);
    }
    if (sawShadowed) {
      unresolved.push(`A same-named but unrelated/shadowed binding of "${oldName}" was left unchanged (scope-correct).`);
    }

    // 4. Sort edits ascending for a stable, deterministic ordering (the engine replays
    //    descending; the host/engine both sort, so order here is purely for determinism).
    edits.sort((a, b) => a.start - b.start);
    return { oldName, newName, edits, unresolved };
  }
}

/** The identifier node whose `[start,end)` contains `offset`, or undefined. */
function identifierAt(sf: ts.SourceFile, offset: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (offset < node.getStart(sf) || offset > node.getEnd()) return;
    if (ts.isIdentifier(node) && offset >= node.getStart(sf) && offset <= node.getEnd()) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** The identifier of the FIRST declaration named `name` (the target a name-based rename binds to). */
function firstDeclarationIdentifier(sf: ts.SourceFile, name: string): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const consider = (id: ts.Node | undefined): void => {
    if (found !== undefined) return;
    if (id !== undefined && ts.isIdentifier(id) && id.text === name) found = id;
  };
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      consider(node.name);
    } else if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      consider(node.name);
    } else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node)) {
      if (node.name !== undefined && ts.isIdentifier(node.name)) consider(node.name);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      consider(node.name);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      consider(node.name);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** The shared, stateless built-in TS/JS analyzer instance. */
export const typescriptAnalyzer: ILanguageAnalyzer = new TypeScriptAnalyzer();
