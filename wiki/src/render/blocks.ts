/**
 * Block/inline render — the fixed normal-form walk (structured-content §3.1, §10).
 * Pure identity projection of the block/inline tree; no Markdown formatter runs.
 * Inputs are assumed already in block normal form (validated at ingestion).
 */
import type { IBlock, IInline, Mark } from "../api";

/** Resolve a ref target to its render-derived label. */
export type LabelResolver = (target: import("../api").RefTarget) => string;

function renderMarks(value: string, marks: Mark[]): string {
  // Marks are canonical-sorted (emphasis < strong < link). Apply from inside out:
  // emphasis (_x_), then strong (**x**), then link ([x](href)).
  let out = value;
  for (const m of marks) {
    if (m === "emphasis") out = `_${out}_`;
    else if (m === "strong") out = `**${out}**`;
  }
  const link = marks.find((m): m is { kind: "link"; href: string } => typeof m === "object" && m.kind === "link");
  if (link !== undefined) out = `[${out}](${link.href})`;
  return out;
}

export function renderInline(inline: IInline, label: LabelResolver): string {
  switch (inline.kind) {
    case "text":
      return renderMarks(inline.value, inline.marks);
    case "code-span":
      return "`" + inline.value + "`";
    case "ref":
      return label(inline.target);
  }
}

export function renderInlines(inlines: IInline[], label: LabelResolver): string {
  return inlines.map((i) => renderInline(i, label)).join("");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function renderBlock(block: IBlock, label: LabelResolver): string {
  switch (block.kind) {
    case "paragraph":
      return renderInlines(block.inlines, label);
    case "heading":
      return "#".repeat(block.level) + " " + renderInlines(block.inlines, label);
    case "code":
      return "```" + block.lang + "\n" + block.source + "\n```";
    case "list": {
      const lines: string[] = [];
      block.items.forEach((item, i) => {
        const marker = block.ordered ? `${i + 1}.` : "-";
        const body = item.map((b) => renderBlock(b, label)).join("\n");
        // For a single-block item keep it on one line; otherwise indent continuation.
        const [first, ...rest] = body.split("\n");
        lines.push(`${marker} ${first ?? ""}`);
        for (const r of rest) lines.push(`  ${r}`);
      });
      return lines.join("\n");
    }
    case "table": {
      const lines: string[] = [];
      lines.push("| " + block.header.map((c) => escapeCell(renderInlines(c, label))).join(" | ") + " |");
      lines.push(
        "| " +
          block.align
            .map((a) => (a === "center" ? ":---:" : a === "left" ? ":---" : a === "right" ? "---:" : "---"))
            .join(" | ") +
          " |",
      );
      for (const row of block.rows) {
        lines.push("| " + row.map((c) => escapeCell(renderInlines(c, label))).join(" | ") + " |");
      }
      return lines.join("\n");
    }
    case "quote":
      return block.blocks
        .map((b) => renderBlock(b, label))
        .join("\n\n")
        .split("\n")
        .map((l) => (l.length > 0 ? `> ${l}` : ">"))
        .join("\n");
    case "divider":
      return "---";
  }
}

export function renderBlocks(blocks: IBlock[], label: LabelResolver): string {
  return blocks.map((b) => renderBlock(b, label)).join("\n\n");
}
