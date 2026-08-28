import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  buildMessages,
  CHAT_OUTPUT_SCHEMA,
  chatSystemPrompt,
  chatTimeoutMsFromEnv,
  chatUserTurn,
  MAX_HISTORY_TURNS,
  MAX_PROPOSAL_OPS,
  proposableCommands,
  runRecipeChat,
  validateChatReply,
  validateOp,
  type ChatTurn,
  type CreateMessage,
} from "./recipe-chat";

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

describe("the prompt", () => {
  it("carries the whole recipe, ids included, in the user turn", () => {
    const turn = chatUserTurn(recipe, "what instead of buttermilk?");
    expect(turn).toContain('"id": "i1"');
    expect(turn).toContain("what instead of buttermilk?");
  });

  it("puts the command contract in the system prompt, not in the per-turn message", () => {
    expect(chatSystemPrompt()).toContain("reviseIngredient");
    expect(chatUserTurn(recipe, "and if I halve it?")).not.toContain("reviseIngredient");
  });
});

describe("the output schema", () => {
  const branches = CHAT_OUTPUT_SCHEMA.properties.proposal.items.anyOf as unknown as readonly {
    properties: {
      command: { const: string };
      args: { properties: Record<string, unknown>; required: readonly string[] };
    };
  }[];

  it("names exactly the commands the allowlist accepts, one branch each", () => {
    expect(branches.map((b) => b.properties.command.const)).toEqual(proposableCommands());
    expect(proposableCommands()).toContain("addIngredient");
  });

  it("offers each command only the arguments it takes", () => {
    // A live turn produced `reviseIngredient {ingredientId, stepId}` under a flat args bag.
    // Per-command branches make a step argument on an ingredient command unrepresentable.
    const branchOf = (name: string) => branches.find((b) => b.properties.command.const === name)!;
    expect(Object.keys(branchOf("reviseIngredient").properties.args.properties)).not.toContain("stepId");
    expect(Object.keys(branchOf("reviseStep").properties.args.properties)).not.toContain("ingredientId");
    expect(Object.keys(branchOf("removeIngredient").properties.args.properties)).toEqual(["ingredientId"]);
  });

  it("requires the id and the mandatory arguments of each command", () => {
    const branchOf = (name: string) => branches.find((b) => b.properties.command.const === name)!;
    expect(branchOf("reviseStep").properties.args.required).toEqual(["stepId", "markdown"]);
    expect(branchOf("addIngredient").properties.args.required).toEqual(["title"]);
  });
});

const turn = (question: string, reply: string, proposal: ChatTurn["proposal"] = []): ChatTurn => ({
  question,
  reply,
  proposal,
});

describe("buildMessages", () => {
  it("sends the recipe exactly once, in the final user message", () => {
    const messages = buildMessages(recipe, "and the sugar?", [turn("what instead of buttermilk?", "soured milk")]);
    const carrying = messages.filter((m) => String(m.content).includes('"id": "i1"'));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toBe(messages[messages.length - 1]);
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  it("replays a past turn as the bare question and the model's own JSON", () => {
    const proposal = [{ command: "addIngredient", args: { title: "vinegar" } }];
    const messages = buildMessages(recipe, "and the sugar?", [turn("swap the buttermilk", "soured milk", proposal)]);
    expect(messages[0]).toEqual({ role: "user", content: "swap the buttermilk" });
    expect(messages[1]?.role).toBe("assistant");
    expect(JSON.parse(String(messages[1]?.content))).toEqual({ reply: "soured milk", proposal });
  });

  it("alternates user and assistant, starting with user", () => {
    const messages = buildMessages(recipe, "q3", [turn("q1", "a1"), turn("q2", "a2")]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("keeps only the last few turns", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => turn(`q${i}`, `a${i}`));
    const messages = buildMessages(recipe, "now", history);
    expect(messages).toHaveLength(MAX_HISTORY_TURNS * 2 + 1);
    expect(messages[0]).toEqual({ role: "user", content: "q3" });
  });

  it("drops a malformed turn rather than sending half of it", () => {
    const history = [
      { question: "", reply: "a", proposal: [] },
      { question: "q", reply: "", proposal: [] },
      turn("real", "answer"),
    ];
    const messages = buildMessages(recipe, "now", history);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]).toEqual({ role: "user", content: "real" });
  });
});

function answer(
  body: unknown,
  stopReason: Anthropic.Message["stop_reason"] = "end_turn",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: stopReason,
    stop_sequence: null,
    content: [
      { type: "thinking", thinking: "weighing the acid", signature: "sig" },
      { type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

const replying = (message: Anthropic.Message): CreateMessage => async () => message;

describe("runRecipeChat", () => {
  it("reads the text block past the thinking block", async () => {
    const out = await runRecipeChat({
      recipe,
      question: "what instead of buttermilk?",
      create: replying(
        answer({
          reply: "Milk with a spoon of vinegar.",
          proposal: [{ command: "reviseIngredient", args: { ingredientId: "i1", title: "soured milk" } }],
        }),
      ),
    });
    expect(out).toEqual({
      ok: true,
      value: {
        reply: "Milk with a spoon of vinegar.",
        proposal: [{ command: "reviseIngredient", args: { ingredientId: "i1", title: "soured milk" } }],
      },
    });
  });

  it("keeps the prose and drops an op the allowlist does not know", async () => {
    const out = await runRecipeChat({
      recipe,
      question: "halve it",
      create: replying(answer({ reply: "Halve everything.", proposal: [{ command: "launchMissiles", args: {} }] })),
    });
    expect(out).toEqual({ ok: true, value: { reply: "Halve everything.", proposal: [] } });
  });

  it("reports a refusal instead of parsing it", async () => {
    const out = await runRecipeChat({ recipe, question: "x", create: replying(answer({ reply: "no" }, "refusal")) });
    expect(out).toEqual({ ok: false, message: "the recipe chat declined to answer" });
  });

  it("reports a reply cut off at the length limit", async () => {
    const out = await runRecipeChat({ recipe, question: "x", create: replying(answer('{"reply":', "max_tokens")) });
    expect(out).toEqual({ ok: false, message: "the recipe chat ran past its length limit" });
  });

  it("reports text that is not JSON", async () => {
    const out = await runRecipeChat({ recipe, question: "x", create: replying(answer("Use soured milk.")) });
    expect(out).toEqual({ ok: false, message: "the recipe chat replied with no usable answer" });
  });

  it("passes the signal and the timeout through, and asks for no tools", async () => {
    const controller = new AbortController();
    let seen: { params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions } | null = null;
    const create: CreateMessage = async (params, options) => {
      seen = { params, options };
      return answer({ reply: "ok", proposal: [] });
    };
    await runRecipeChat({
      recipe,
      question: "x",
      timeoutMs: 12_345,
      signal: controller.signal,
      create,
    });
    const call = seen as unknown as { params: Record<string, unknown>; options: Record<string, unknown> };
    expect(call.options.timeout).toBe(12_345);
    expect(call.options.signal).toBe(controller.signal);
    expect(call.params.model).toBe("claude-opus-5");
    expect(call.params.thinking).toEqual({ type: "adaptive" });
    expect(call.params).not.toHaveProperty("tools");
  });

  it("turns an API failure into one sentence", async () => {
    const create: CreateMessage = async () => {
      throw new Error("boom");
    };
    expect(await runRecipeChat({ recipe, question: "x", create })).toEqual({
      ok: false,
      message: "the recipe chat failed",
    });
  });
});

describe("chatTimeoutMsFromEnv", () => {
  it("takes a positive number of milliseconds", () => {
    expect(chatTimeoutMsFromEnv({ WIKI_UI_CHAT_TIMEOUT_MS: "5000" }, 1000)).toBe(5000);
  });

  it("falls back on anything else", () => {
    expect(chatTimeoutMsFromEnv({}, 1000)).toBe(1000);
    expect(chatTimeoutMsFromEnv({ WIKI_UI_CHAT_TIMEOUT_MS: "0" }, 1000)).toBe(1000);
    expect(chatTimeoutMsFromEnv({ WIKI_UI_CHAT_TIMEOUT_MS: "abc" }, 1000)).toBe(1000);
  });
});


describe("validateOp — arguments belong to their command", () => {
  it("drops an argument the command does not take", () => {
    // The exact shape a live turn returned before the schema branched per command.
    expect(validateOp({ command: "reviseIngredient", args: { ingredientId: "i3", stepId: "i3" } })).toBeNull();
    expect(
      validateOp({ command: "reviseIngredient", args: { ingredientId: "i3", stepId: "s1", title: "vegan butter" } }),
    ).toEqual({ command: "reviseIngredient", args: { ingredientId: "i3", title: "vegan butter" } });
  });

  it("rejects a revision that revises nothing", () => {
    // It would validate, render as "Change butter", then fail on Apply: the engine refuses a
    // mutation that changes no field.
    expect(validateOp({ command: "reviseIngredient", args: { ingredientId: "i3" } })).toBeNull();
  });

  it("still accepts a removal, which carries only its id", () => {
    expect(validateOp({ command: "removeIngredient", args: { ingredientId: "i3" } })).toEqual({
      command: "removeIngredient",
      args: { ingredientId: "i3" },
    });
  });
});
