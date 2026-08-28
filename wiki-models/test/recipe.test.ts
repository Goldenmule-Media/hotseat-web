/**
 * The `recipe` type driven through the REAL engine (`wiki/testing`), asserting the thing
 * the type exists for: one authored ingredient list, projected two ways — the recipe's own
 * structure on one side and the shopping list on the other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "wiki";
import { createTestWiki } from "wiki/testing";

import { Recipe } from "../src/recipe/recipe";

describe("recipe", () => {
  let wiki: IWiki;
  let stop: () => Promise<void>;
  let ws: IWorkspaceHandle;

  beforeEach(async () => {
    const test = await createTestWiki([Recipe]);
    wiki = test.wiki;
    stop = test.stop;
    ws = await wiki.createWorkspace({ name: "Recipes" });
  });

  afterEach(async () => {
    await stop();
  });

  const newRecipe = async (title: string): Promise<PageId> => {
    const { value } = await ws.createPage("recipe", { title, parentId: null });
    return value;
  };

  const markdown = async (page: PageId): Promise<string> => (await ws.page(page)).toMarkdown();

  const section = (md: string, heading: string): string => {
    const start = md.indexOf(`## ${heading}`);
    if (start === -1) return "";
    const next = md.indexOf("\n## ", start + 1);
    return next === -1 ? md.slice(start) : md.slice(start, next);
  };

  it("keeps a divided ingredient divided, and adds it back up to shop for", async () => {
    // Burger Buns: "1 egg + 1 egg (wash)". The dough and the wash need them separately;
    // the shop needs the total.
    const page = await newRecipe("Burger Buns");
    await ws.mutate(page, "addIngredient", { title: "egg", qty: 3, group: "Dough" });
    await ws.mutate(page, "addIngredient", { title: "egg", qty: 2, group: "Egg wash" });

    const md = await markdown(page);
    const ingredients = section(md, "Ingredients");
    expect(ingredients).toContain("**Dough**");
    expect(ingredients).toContain("**Egg wash**");
    expect(ingredients).toContain("3 egg");
    expect(ingredients).toContain("2 egg");

    const shopping = section(md, "Shopping list");
    expect(shopping).toContain("5 egg");
    expect(shopping).not.toContain("3 egg");
  });

  it("groups in first-appearance order, never sorted", async () => {
    const page = await newRecipe("Hotteok");
    await ws.mutate(page, "addIngredient", { title: "flour", qty: 640, unit: "g", group: "Dough" });
    await ws.mutate(page, "addIngredient", { title: "brown sugar", qty: "1/2", unit: "cup", group: "Filling" });
    await ws.mutate(page, "addIngredient", { title: "instant yeast", qty: 4, unit: "tsp", group: "Dough" });

    const ingredients = section(await markdown(page), "Ingredients");
    expect(ingredients.indexOf("**Dough**")).toBeLessThan(ingredients.indexOf("**Filling**"));
    // Both Dough ingredients sit under its header, even though one was authored later.
    expect(ingredients.indexOf("640 g flour")).toBeLessThan(ingredients.indexOf("**Filling**"));
    expect(ingredients.indexOf("4 tsp instant yeast")).toBeLessThan(ingredients.indexOf("**Filling**"));
  });

  it("sums across units when the ingredient bridges", async () => {
    const page = await newRecipe("Shortbread");
    await ws.mutate(page, "addIngredient", { title: "butter", qty: 1, unit: "stick", group: "Dough" });
    await ws.mutate(page, "addIngredient", { title: "butter", qty: 3, unit: "T", group: "Topping" });

    const shopping = section(await markdown(page), "Shopping list");
    // 1 stick (113 g) + 3 tbsp of butter, in grams — one row, not two.
    expect(shopping).toMatch(/1[45]\d g butter/);
  });

  it("lists measures side by side rather than inventing a total", async () => {
    const page = await newRecipe("Walnut loaf");
    await ws.mutate(page, "addIngredient", { title: "chopped walnuts", qty: 1, unit: "cup" });
    await ws.mutate(page, "addIngredient", { title: "chopped walnuts", qty: 2, unit: "each" });

    const shopping = section(await markdown(page), "Shopping list");
    expect(shopping).toContain("1 cup + 2 chopped walnuts");
  });

  it("merges rows the author routed to one shopping line", async () => {
    const page = await newRecipe("Pie Crust");
    await ws.mutate(page, "addIngredient", { title: "all purpose flour", qty: 58, unit: "g", shopAs: "flour" });
    await ws.mutate(page, "addIngredient", { title: "all purpose flour", qty: 117, unit: "g", shopAs: "flour" });

    const md = await markdown(page);
    expect(section(md, "Ingredients")).toContain("58 g all purpose flour");
    expect(section(md, "Shopping list")).toContain("175 g flour");
  });

  it("weighs the same teaspoon differently per salt brand", async () => {
    // Only a bucket that has to COMBINE crosses into grams — a lone `8 tsp` stays `8 tsp`,
    // which is what you want on a shopping list. Give each recipe a teaspoon measure and a
    // gram measure of its own salt and the brand's density decides the total.
    const saltRecipe = async (title: string, salt: string): Promise<string> => {
      const page = await newRecipe(title);
      await ws.mutate(page, "addIngredient", { title: salt, qty: 8, unit: "tsp", shopAs: "salt" });
      await ws.mutate(page, "addIngredient", { title: salt, qty: 10, unit: "g", shopAs: "salt" });
      return section(await markdown(page), "Shopping list");
    };

    // 8 tsp of Diamond is 22.4 g against table salt's 48 g. "Double salt when using diamond."
    expect(await saltRecipe("Sausage", "diamond salt")).toContain("32.4 g salt");
    expect(await saltRecipe("Sausage, table salt", "table salt")).toContain("58 g salt");
  });

  it("accepts a written quantity and folds the unit to its canonical token", async () => {
    const page = await newRecipe("Pancakes");
    await ws.mutate(page, "addIngredient", { title: "milk", qty: "1 1/4", unit: "C" });
    expect(section(await markdown(page), "Ingredients")).toContain("1 ¼ cup milk");
  });

  it("renders cleanly when there is nothing but a source", async () => {
    const page = await newRecipe("Carbonara");
    await ws.mutate(page, "setSourceUrl", { value: "https://www.bonappetit.com/recipe/simple-carbonara" });

    const md = await markdown(page);
    expect(md).toContain("**Source:** https://www.bonappetit.com/recipe/simple-carbonara");
    expect(md).toContain("_No ingredients yet._");
    expect(md).toContain("_No steps yet._");
    // Placeholders, never a stray heading level or a dangling bullet.
    expect(md).not.toMatch(/^#{3,}\s*\d*\.\s*$/m);
  });

  it("numbers steps and keeps their headings non-empty", async () => {
    const page = await newRecipe("Burger Buns");
    await ws.mutate(page, "addStep", { title: "Mix and knead", markdown: "Mix. Knead for 6 minutes." });
    await ws.mutate(page, "addStep", { title: "Shape", markdown: "Divide into 8 and form balls." });

    const steps = section(await markdown(page), "Instructions");
    expect(steps).toContain("### 1. Mix and knead");
    expect(steps).toContain("### 2. Shape");
    expect(steps).not.toMatch(/###\s+\d+\.\s*$/m);
  });

  it("unpairs every ingredient when the step they pointed at is deleted", async () => {
    const page = await newRecipe("Burger Buns");
    const step = await ws.mutate(page, "addStep", { title: "Egg wash", markdown: "Beat egg with 1 T water." });
    const stepId = (step.value as { stepId: string }).stepId;
    const ingredient = await ws.mutate(page, "addIngredient", { title: "egg", qty: 1 });
    const ingredientId = (ingredient.value as { ingredientId: string }).ingredientId;

    await ws.mutate(page, "pairIngredient", { ingredientId, stepId });
    await ws.mutate(page, "removeStep", { stepId });

    const state = await (await ws.page(page)).state();
    const items = state.sections.find((s) => s.key === "ingredients")?.fields["items"];
    const paired = items !== undefined && items.kind === "list" ? items.elements[0]?.fields["stepId"] : undefined;
    expect(paired !== undefined && paired.kind === "scalar" ? paired.value : "unset").toBe("");
  });

  it("refuses to pair with a step that is not on the page", async () => {
    const page = await newRecipe("Burger Buns");
    const ingredient = await ws.mutate(page, "addIngredient", { title: "egg", qty: 1 });
    const ingredientId = (ingredient.value as { ingredientId: string }).ingredientId;

    await expect(ws.mutate(page, "pairIngredient", { ingredientId, stepId: "nope" })).rejects.toThrow(/not found/);
  });

  it("stays editable after it has been made", async () => {
    const page = await newRecipe("Burger Buns");
    await ws.mutate(page, "made", {});
    await ws.mutate(page, "addNote", { title: "1/24/24", markdown: "Very good. Kids loved them." });

    const md = await markdown(page);
    expect(await (await ws.page(page)).status()).toBe("made");
    expect(section(md, "Notes")).toContain("### 1/24/24");
  });
});
