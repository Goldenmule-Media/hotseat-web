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
  ILanguageAnalyzer,
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
}

/** The shared, stateless built-in TS/JS analyzer instance. */
export const typescriptAnalyzer: ILanguageAnalyzer = new TypeScriptAnalyzer();
