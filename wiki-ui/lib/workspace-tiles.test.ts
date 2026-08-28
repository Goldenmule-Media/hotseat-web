import { describe, expect, it } from "vitest";

import type { IWorkspaceSummary, WorkspaceId } from "wiki";
import { changedLabel, sortByActivity } from "./workspace-tiles";

const ws = (id: string, name: string): IWorkspaceSummary =>
  ({ id: id as WorkspaceId, name, status: "active" }) as IWorkspaceSummary;

describe("sortByActivity", () => {
  const a = ws("ws:a", "Alpha");
  const b = ws("ws:b", "Beta");
  const c = ws("ws:c", "Gamma");

  it("puts the most recently changed first", () => {
    const order = sortByActivity([a, b, c], {
      ["ws:a" as WorkspaceId]: "2026-08-01T00:00:00.000Z",
      ["ws:b" as WorkspaceId]: "2026-08-28T00:00:00.000Z",
      ["ws:c" as WorkspaceId]: "2026-08-14T00:00:00.000Z",
    });
    expect(order.map((w) => w.id)).toEqual(["ws:b", "ws:c", "ws:a"]);
  });

  it("keeps unknown-activity workspaces last, alphabetically", () => {
    const order = sortByActivity([c, b, a], { ["ws:b" as WorkspaceId]: "2026-08-28T00:00:00.000Z" });
    expect(order.map((w) => w.id)).toEqual(["ws:b", "ws:a", "ws:c"]);
  });

  it("is alphabetical before any activity has arrived", () => {
    expect(sortByActivity([c, a, b], {}).map((w) => w.id)).toEqual(["ws:a", "ws:b", "ws:c"]);
  });

  it("does not mutate its input", () => {
    const items = [c, a];
    sortByActivity(items, {});
    expect(items.map((w) => w.id)).toEqual(["ws:c", "ws:a"]);
  });
});

describe("changedLabel", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("reads in units that stay meaningful", () => {
    expect(changedLabel("2026-08-28T11:59:30.000Z", now)).toBe("just now");
    expect(changedLabel("2026-08-28T11:20:00.000Z", now)).toBe("40m ago");
    expect(changedLabel("2026-08-28T09:00:00.000Z", now)).toBe("3h ago");
    expect(changedLabel("2026-08-26T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("falls back to a date once 'N days ago' stops meaning anything", () => {
    expect(changedLabel("2026-06-04T12:00:00.000Z", now)).toMatch(/2026/);
  });

  it("has no label for a missing or unparseable timestamp", () => {
    expect(changedLabel(undefined, now)).toBeUndefined();
    expect(changedLabel("not a date", now)).toBeUndefined();
  });
});
