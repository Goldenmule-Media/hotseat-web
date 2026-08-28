import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { decideAnthropicAvailability, describeAnthropicError } from "./anthropic";

describe("decideAnthropicAvailability", () => {
  it("is unavailable, and says why, with no key", () => {
    const out = decideAnthropicAvailability({});
    expect(out.available).toBe(false);
    expect(out.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty key as no key", () => {
    expect(decideAnthropicAvailability({ ANTHROPIC_API_KEY: "" }).available).toBe(false);
    expect(decideAnthropicAvailability({ ANTHROPIC_API_KEY: "   " }).available).toBe(false);
  });

  it("is available with a key", () => {
    expect(decideAnthropicAvailability({ ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({ available: true });
  });
});

describe("describeAnthropicError", () => {
  it("tells a cancellation from a timeout", () => {
    expect(describeAnthropicError(new Anthropic.APIUserAbortError({}))).toBe("was cancelled");
    expect(describeAnthropicError(new Anthropic.APIConnectionTimeoutError({}))).toBe("timed out");
  });

  it("names a bad key and a rate limit", () => {
    const headers = new Headers();
    expect(describeAnthropicError(new Anthropic.AuthenticationError(401, undefined, "no", headers))).toContain(
      "the API key is not valid",
    );
    expect(describeAnthropicError(new Anthropic.RateLimitError(429, undefined, "slow down", headers))).toContain(
      "rate limited",
    );
  });

  it("falls back to the status, then to nothing at all", () => {
    const other = new Anthropic.InternalServerError(500, undefined, "oops", new Headers());
    expect(describeAnthropicError(other)).toBe("failed (HTTP 500)");
    expect(describeAnthropicError(new Anthropic.APIConnectionError({}))).toBe("could not reach the API");
    expect(describeAnthropicError(new Error("boom"))).toBe("failed");
  });
});
