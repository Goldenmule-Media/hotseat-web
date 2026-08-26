/**
 * A page type that can INLINE its children's content, discovered from the model rather than
 * by name — the same discipline as `typesRenderingOwnChildren` reading `graphSections`.
 *
 * The engine renders `@children-content` when a stored scalar selects it (a render section's
 * `when: { field, equals }`). Everything the editor needs to offer a toggle is therefore
 * already declared: which field holds the mode, which value means "inline", which value is
 * the default, and which command writes it. This reads all four off the page-type definition
 * so no component ever mentions `toc` or `display.contents`.
 */
import type { IPageTypeDef } from "wiki";

export interface ContentsMode {
  /** The command that writes the mode, e.g. `setContentsMode`. */
  readonly command: string;
  /** That command's single argument name, e.g. `mode`. */
  readonly arg: string;
  /** The value that inlines child content. */
  readonly inline: string;
  /** The value that falls back to the type's own listing — the unset default. */
  readonly links: string;
}

/** `"<section>.<field>"` → the two halves, or null when malformed. */
function splitField(field: string): { section: string; key: string } | null {
  const dot = field.indexOf(".");
  return dot < 0 ? null : { section: field.slice(0, dot), key: field.slice(dot + 1) };
}

/** A command's args schema property names, for a JSON-Schema-ish object. */
function argNames(schema: unknown): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props === undefined ? [] : Object.keys(props);
}

/** The enum values a command's single argument accepts, if it declares any. */
function argEnum(schema: unknown, arg: string): string[] {
  const prop = (schema as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties?.[arg];
  return (prop?.enum ?? []).filter((v): v is string => typeof v === "string");
}

/**
 * How to toggle this type between inlining its children and listing them, or null when the
 * type has no such mode. Requires all of it to line up: a `@children-content` section gated
 * on a field, a sibling section naming the same field as its default (`orUnset`), and a
 * command targeting that field with an enum covering both values.
 */
export function contentsModeOf(def: IPageTypeDef | null): ContentsMode | null {
  if (def === null) return null;
  const sections = def.render.sections;
  const inlineSection = sections.find((s) => s.section === "@children-content" && s.when !== undefined);
  if (inlineSection?.when === undefined) return null;
  const { field, equals: inline } = inlineSection.when;
  const target = splitField(field);
  if (target === null) return null;

  // The default mode is whatever the sibling config over the same field matches when unset.
  const defaultSection = sections.find(
    (s) => s !== inlineSection && s.when?.field === field && s.when.orUnset === true,
  );
  const links = defaultSection?.when?.equals;
  if (links === undefined) return null;

  for (const [command, decl] of Object.entries(def.commands)) {
    if (decl.target?.section !== target.section || decl.target.field !== target.key) continue;
    const args = argNames(decl.args.toJsonSchema());
    if (args.length !== 1) continue;
    const values = argEnum(decl.args.toJsonSchema(), args[0]);
    if (!values.includes(inline) || !values.includes(links)) continue;
    return { command, arg: args[0], inline, links };
  }
  return null;
}

/** Is this page currently inlining its children? Reads the same field the render gates on. */
export function isInline(
  def: IPageTypeDef | null,
  mode: ContentsMode | null,
  sectionsOf: (section: string, field: string) => string | undefined,
): boolean {
  if (def === null || mode === null) return false;
  const inlineSection = def.render.sections.find((s) => s.section === "@children-content");
  const target = inlineSection?.when === undefined ? null : splitField(inlineSection.when.field);
  if (target === null) return false;
  return sectionsOf(target.section, target.key) === mode.inline;
}
