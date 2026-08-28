import { describe, expect, it } from "vitest";

import { chatPrompt, MAX_PROPOSAL_OPS, validateChatReply, validateOp } from "./recipe-chat";

const recipe = {
  title: "Burger Buns",
  ingredients: [{ id: "i1", name: "egg", qty: "1", unit: "", prep: "", group: "Dough" }],
  steps: [{ id: "s1", title: "Mix", group: "Dough", body: "Mix it." }],
};

describe("validateOp", () => {
  it("accepts a real command with the id it needs", () => {
    expect(validateOp({ command: "reviseIngredient", args: { ingredientId: "i1", qty: 2 } })).toEqual({
      command: "reviseIngredient",
      args: { ingredientId: "i1", qty: 2 },
    });
  });

  it("rejects a command that is not proposable", () => {
    // Status, files and ordering are not the chat's to change.
    expect(validateOp({ command: "made", args: {} })).toBeNull();
    expect(validateOp({ command: "moveIngredient", args: { ingredientId: "i1", toIndex: 0 } })).toBeNull();
    expect(validateOp({ command: "attachFile", args: { ref: "x", label: "y" } })).toBeNull();
    expect(validateOp({ command: "rm -rf", args: {} })).toBeNull();
  });

  it("rejects an op missing the id that names its target", () => {
    expect(validateOp({ command: "reviseIngredient", args: { qty: 2 } })).toBeNull();
    expect(validateOp({ command: "removeStep", args: {} })).toBeNull();
  });

  it("rejects an op missing a required argument", () => {
    expect(validateOp({ command: "addIngredient", args: { qty: 2 } })).toBeNull();
    expect(validateOp({ command: "addStep", args: { title: "Mix" } })).toBeNull();
  });

  it("drops arguments that are not primitives", () => {
    const op = validateOp({ command: "addIngredient", args: { title: "egg", nested: { a: 1 }, list: [1] } });
    expect(op).toEqual({ command: "addIngredient", args: { title: "egg" } });
  });

  it("rejects anything that is not an op at all", () => {
    for (const raw of [null, "addIngredient", [], { args: {} }, { command: "addIngredient" }]) {
      expect(validateOp(raw)).toBeNull();
    }
  });
});

describe("validateChatReply", () => {
  it("keeps the prose answer and the ops that survive validation", () => {
    const parsed = validateChatReply({
      reply: "Use milk with a spoon of vinegar.",
      proposal: [
        { command: "reviseIngredient", args: { ingredientId: "i1", title: "soured milk" } },
        { command: "launchMissiles", args: {} },
      ],
    });
    expect(parsed?.reply).toBe("Use milk with a spoon of vinegar.");
    expect(parsed?.proposal).toHaveLength(1);
  });

  it("is fine with an answer that proposes nothing", () => {
    expect(validateChatReply({ reply: "It will be denser." })).toEqual({ reply: "It will be denser.", proposal: [] });
  });

  it("caps a proposal that tries to rewrite everything", () => {
    const ops = Array.from({ length: 40 }, () => ({ command: "addIngredient", args: { title: "x" } }));
    expect(validateChatReply({ reply: "ok", proposal: ops })?.proposal).toHaveLength(MAX_PROPOSAL_OPS);
  });

  it("rejects a reply with no prose", () => {
    expect(validateChatReply({ proposal: [] })).toBeNull();
    expect(validateChatReply(null)).toBeNull();
  });
});

describe("chatPrompt", () => {
  it("carries the whole recipe, ids included, on the first turn", () => {
    const prompt = chatPrompt(recipe, "what instead of buttermilk?", false);
    expect(prompt).toContain('"id": "i1"');
    expect(prompt).toContain("what instead of buttermilk?");
    expect(prompt).toContain("addIngredient");
  });

  it("still carries the whole recipe on a follow-up, since it may have changed", () => {
    const prompt = chatPrompt(recipe, "and if I halve it?", true);
    expect(prompt).toContain('"id": "i1"');
    // The command contract is in the session, so the follow-up does not repeat it.
    expect(prompt).not.toContain("reviseIngredient");
  });
});
