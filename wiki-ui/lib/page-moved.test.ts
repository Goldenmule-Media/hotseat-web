import { describe, expect, it } from "vitest";
import { PageMovedError } from "wiki";
import { classifyError, toWikiErrorDTO } from "./wiki-host-api";

describe("a moved page", () => {
  it("crosses the worker boundary with where it lives now", () => {
    const dto = toWikiErrorDTO(new PageMovedError("toc:kit", "ws:target"));
    expect(dto).toMatchObject({ code: "PAGE_MOVED", workspaceId: "ws:target", pageId: "toc:kit" });
    expect(classifyError(structuredClone(dto))).toMatchObject({
      kind: "moved",
      movedTo: { workspaceId: "ws:target", pageId: "toc:kit" },
    });
  });

  it("other engine errors carry no move target", () => {
    const dto = toWikiErrorDTO({ code: "PAGE_NOT_FOUND", message: "gone", workspaceId: "ws:x", pageId: "p:1" });
    expect(dto.workspaceId).toBeUndefined();
    expect(classifyError(dto).kind).toBe("engine");
  });
});
