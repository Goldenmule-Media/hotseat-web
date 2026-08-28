import { describe, expect, it } from "vitest";

import type { SectionElementSummary } from "./wiki-host-api";
import {
  applyOverlay,
  applyProposal,
  describeOp,
  groupIngredients,
  type Ingredient,
  ingredientsForStep,
  parseIngredientLine,
  readIngredients,
  readFiles,
  readNotes,
  readSteps,
  shoppingList,
  stripHeading,
  titleFromBody,
} from "./recipe";

const ingredient = (over: Partial<Ingredient> & { id: string; name: string }): Ingredient => ({
  qty: "",
  unit: "",
  prep: "",
  group: "",
  shopAs: "",
  note: "",
  stepId: "",
  ...over,
});

const summary = (id: string, title: string, scalars: Record<string, string>): SectionElementSummary => ({
  id,
  title,
  scalars,
});

describe("readIngredients", () => {
  it("reads the scalars the worker surfaces, defaulting the absent ones", () => {
    const [row] = readIngredients([summary("i1", "flour", { qty: "640", unit: "g" })]);
    expect(row).toEqual({
      id: "i1",
      name: "flour",
      qty: "640",
      unit: "g",
      prep: "",
      group: "",
      shopAs: "",
      note: "",
      stepId: "",
    });
  });
});

describe("readSteps", () => {
  it("takes the render's numbered heading back off the body", () => {
    const steps = readSteps(
      [summary("s1", "Mix and knead", { group: "Dough" })],
      [{ id: "s1", markdown: "### 1. Mix and knead\n\nMix. Knead for 6 minutes." }],
    );
    expect(steps[0]).toEqual({ id: "s1", title: "Mix and knead", group: "Dough", body: "Mix. Knead for 6 minutes." });
  });

  it("leaves a body that has no heading alone", () => {
    expect(stripHeading("Just the instruction.")).toBe("Just the instruction.");
  });
});

describe("groupIngredients", () => {
  it("buckets by first appearance, ungrouped included", () => {
    const rows = [
      ingredient({ id: "a", name: "flour", group: "Dough" }),
      ingredient({ id: "b", name: "sesame seeds" }),
      ingredient({ id: "c", name: "yeast", group: "Dough" }),
    ];
    expect(groupIngredients(rows).map((g) => g.group)).toEqual(["Dough", ""]);
    expect(groupIngredients(rows)[0]!.items.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("shoppingList", () => {
  it("adds a divided ingredient back up", () => {
    const rows = [
      ingredient({ id: "a", name: "egg", qty: "3", group: "Dough" }),
      ingredient({ id: "b", name: "egg", qty: "2", group: "Egg wash" }),
    ];
    const list = shoppingList(rows);
    expect(list).toHaveLength(1);
    expect(list[0]!.total).toBe("5");
    expect(list[0]!.from).toEqual(["a", "b"]);
  });

  it("merges rows the author routed to one line, and weighs by the real ingredient", () => {
    // Both shop as "salt", but the density that matters is Diamond Crystal's.
    const rows = [
      ingredient({ id: "a", name: "diamond salt", qty: "8", unit: "tsp", shopAs: "salt" }),
      ingredient({ id: "b", name: "diamond salt", qty: "10", unit: "g", shopAs: "salt" }),
    ];
    expect(shoppingList(rows)[0]).toMatchObject({ label: "salt", total: "32.4 g" });
  });

  it("keeps measures that will not combine side by side", () => {
    const rows = [
      ingredient({ id: "a", name: "chopped walnuts", qty: "1", unit: "cup" }),
      ingredient({ id: "b", name: "chopped walnuts", qty: "2" }),
    ];
    expect(shoppingList(rows)[0]!.total).toBe("1 cup + 2");
  });

  it("skips a row with no name at all", () => {
    expect(shoppingList([ingredient({ id: "a", name: "  " })])).toEqual([]);
  });
});

describe("ingredientsForStep", () => {
  const step = { id: "s1", title: "Egg wash", group: "Egg wash", body: "" };

  it("prefers an explicit pairing over the group", () => {
    const rows = [
      ingredient({ id: "a", name: "egg", stepId: "s1", group: "Dough" }),
      ingredient({ id: "b", name: "egg", group: "Egg wash" }),
    ];
    expect(ingredientsForStep(rows, step)).toEqual(["a"]);
  });

  it("falls back to the shared group when nothing is paired", () => {
    const rows = [
      ingredient({ id: "a", name: "flour", group: "Dough" }),
      ingredient({ id: "b", name: "egg", group: "Egg wash" }),
    ];
    expect(ingredientsForStep(rows, step)).toEqual(["b"]);
  });

  it("pairs nothing for an ungrouped step", () => {
    const rows = [ingredient({ id: "a", name: "flour", group: "Dough" })];
    expect(ingredientsForStep(rows, { ...step, group: "" })).toEqual([]);
  });
});

describe("titleFromBody", () => {
  it("takes the first clause so a prose step stays one field to author", () => {
    expect(titleFromBody("Mix. Knead for 6 minutes.")).toBe("Mix");
    expect(titleFromBody("Preheat oven to 375")).toBe("Preheat oven to 375");
  });

  it("truncates a long clause and never returns nothing", () => {
    expect(titleFromBody("x".repeat(90))).toHaveLength(58);
    expect(titleFromBody("   ")).toBe("Step");
  });
});

describe("readFiles", () => {
  const SHA = "a".repeat(64);

  it("tells a linked document from an inline picture", () => {
    const md = `# R\n\n## Files\n[Focaccia.pdf](attachment:${SHA})\n\n![the printed page](attachment:${"b".repeat(64)})\n\n## Notes\n_None._\n`;
    expect(readFiles(md)).toEqual([
      { ref: `attachment:${SHA}`, label: "Focaccia.pdf", isImage: false },
      { ref: `attachment:${"b".repeat(64)}`, label: "the printed page", isImage: true },
    ]);
  });

  it("does not reach outside the Files section", () => {
    const md = `# R\n\n## Files\n_No files._\n\n## Notes\n### 1/24/24\nSee [this](https://example.com).\n`;
    expect(readFiles(md)).toEqual([]);
  });

  it("is empty before the page has rendered", () => {
    expect(readFiles(null)).toEqual([]);
  });
});

describe("readNotes", () => {
  it("pairs each label with its body, heading stripped", () => {
    const notes = readNotes(
      [summary("n1", "12/29/24", {})],
      [{ id: "n1", markdown: "### 12/29/24\n\nForgot the brown sugar." }],
    );
    expect(notes[0]).toEqual({ id: "n1", title: "12/29/24", body: "Forgot the brown sugar." });
  });
});

describe("applyOverlay", () => {
  const rows = [
    ingredient({ id: "i1", name: "buttermilk", qty: "1", unit: "cup", group: "Wet" }),
    ingredient({ id: "i2", name: "flour", qty: "3", unit: "cup", group: "Dry" }),
  ];
  const steps = [{ id: "s1", title: "Mix", group: "Dry", body: "Mix it." }];

  it("marks a revision without touching the stored rows", () => {
    const overlay = applyOverlay(rows, steps, [
      { command: "reviseIngredient", args: { ingredientId: "i1", title: "soured milk" } },
    ]);
    expect(overlay.ingredients[0]).toMatchObject({ name: "soured milk", change: "changed" });
    expect(rows[0]!.name).toBe("buttermilk");
  });

  it("mints a synthetic id for an addition, which never reaches the engine", () => {
    const overlay = applyOverlay(rows, steps, [
      { command: "addIngredient", args: { title: "vinegar", qty: "1", unit: "tbsp" } },
    ]);
    expect(overlay.ingredients).toHaveLength(3);
    expect(overlay.ingredients[2]).toMatchObject({ name: "vinegar", change: "added" });
    expect(overlay.ingredients[2]!.id).toMatch(/^proposed:/);
  });

  it("marks a removal rather than dropping the row, so the change is visible", () => {
    const overlay = applyOverlay(rows, steps, [{ command: "removeIngredient", args: { ingredientId: "i2" } }]);
    expect(overlay.ingredients).toHaveLength(2);
    expect(overlay.ingredients[1]!.change).toBe("removed");
  });

  it("reports an op naming a row that is gone instead of silently skipping it", () => {
    const overlay = applyOverlay(rows, steps, [{ command: "reviseIngredient", args: { ingredientId: "gone" } }]);
    expect(overlay.unapplied).toHaveLength(1);
    expect(overlay.ingredients).toEqual(rows);
  });

  it("is the identity when nothing is proposed", () => {
    const overlay = applyOverlay(rows, steps, []);
    expect(overlay.ingredients).toEqual(rows);
    expect(overlay.steps).toEqual(steps);
  });

  it("revises and rewrites steps too", () => {
    const overlay = applyOverlay(rows, steps, [
      { command: "reviseStep", args: { stepId: "s1", markdown: "Whisk it." } },
      { command: "addStep", args: { title: "Rest", markdown: "Wait an hour." } },
    ]);
    expect(overlay.steps[0]).toMatchObject({ body: "Whisk it.", change: "changed" });
    expect(overlay.steps[1]).toMatchObject({ title: "Rest", change: "added" });
  });
});

describe("applyProposal", () => {
  it("replays every op and counts what the engine refused", async () => {
    const seen: string[] = [];
    const result = await applyProposal(
      [
        { command: "addIngredient", args: { title: "vinegar" } },
        { command: "removeIngredient", args: { ingredientId: "i2" } },
      ],
      async (command) => {
        seen.push(command);
        return command !== "removeIngredient";
      },
    );
    expect(seen).toEqual(["addIngredient", "removeIngredient"]);
    expect(result).toEqual({ applied: 1, failed: 1 });
  });
});

describe("describeOp", () => {
  it("names the row a change is about, not its id", () => {
    const rows = [ingredient({ id: "i1", name: "buttermilk" })];
    expect(describeOp({ command: "reviseIngredient", args: { ingredientId: "i1", qty: "2", unit: "cup" } }, rows, []))
      .toBe("Change buttermilk to 2 cup");
    expect(describeOp({ command: "removeIngredient", args: { ingredientId: "i1" } }, rows, [])).toBe(
      "Remove buttermilk",
    );
  });
});

describe("parseIngredientLine", () => {
  it("takes the quantity and unit off the front of a typed line", () => {
    expect(parseIngredientLine("3.5 C all purpose flour")).toEqual({
      title: "all purpose flour",
      qty: "3.5",
      unit: "C",
    });
  });

  it("keeps a compound fraction together", () => {
    expect(parseIngredientLine("1 1/4 tsp salt")).toEqual({ title: "salt", qty: "1 1/4", unit: "tsp" });
    expect(parseIngredientLine("1 ½ tsp salt")).toEqual({ title: "salt", qty: "1 ½", unit: "tsp" });
  });

  it("leaves a line with no leading quantity whole", () => {
    // "Sesame seeds" is an ingredient, not a parse failure.
    expect(parseIngredientLine("Sesame seeds")).toEqual({ title: "Sesame seeds" });
  });

  it("does not eat the name as a unit when nothing follows it", () => {
    expect(parseIngredientLine("2 eggs")).toEqual({ title: "eggs", qty: "2" });
  });

  it("is empty for an empty line", () => {
    expect(parseIngredientLine("   ")).toEqual({ title: "" });
  });
});
