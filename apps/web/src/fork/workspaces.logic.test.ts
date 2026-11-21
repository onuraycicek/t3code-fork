import { describe, expect, it } from "vite-plus/test";

import {
  isThreadInWorkspace,
  moveThreadTagChanges,
  pickWorkspaceForWindow,
  reorderWorkspaces,
  threadWorkspaceIds,
  type WorkspaceMembershipContext,
} from "./workspaces.logic";

const context = (
  tags: Record<string, string[]>,
  overrides: Partial<WorkspaceMembershipContext> = {},
): WorkspaceMembershipContext => ({
  knownIds: new Set(["def", "yt", "sir"]),
  defaultId: "def",
  tagsByKey: new Map(Object.entries(tags)),
  ...overrides,
});

describe("threadWorkspaceIds", () => {
  it("puts an untagged thread in the default workspace", () => {
    expect(threadWorkspaceIds("e:a", null, context({ "e:a": [] }))).toEqual(["def"]);
    expect(threadWorkspaceIds("e:unknown", null, context({}))).toEqual(["def"]);
  });

  it("reads workspace tags and ignores other tags", () => {
    const ctx = context({ "e:a": ["urgent", "workspace:yt", "workspace:sir"] });
    expect(threadWorkspaceIds("e:a", null, ctx)).toEqual(["yt", "sir"]);
  });

  it("sends a thread whose workspace was deleted to the default one", () => {
    const ctx = context({ "e:a": ["workspace:gone"] });
    expect(threadWorkspaceIds("e:a", null, ctx)).toEqual(["def"]);
    expect(isThreadInWorkspace("def", "e:a", null, ctx)).toBe(true);
  });

  it("makes a subagent follow its root thread", () => {
    const ctx = context({ "e:root": ["workspace:yt"], "e:child": ["workspace:sir"] });
    expect(threadWorkspaceIds("e:child", "e:root", ctx)).toEqual(["yt"]);
  });

  it("falls back to the subagent's own tags when the root has none", () => {
    const ctx = context({ "e:root": [], "e:child": ["workspace:sir"] });
    expect(threadWorkspaceIds("e:child", "e:root", ctx)).toEqual(["sir"]);
  });

  it("places nothing while the registry has no default yet", () => {
    const ctx = context({ "e:a": [] }, { defaultId: null });
    expect(threadWorkspaceIds("e:a", null, ctx)).toEqual([]);
  });

  it("lets the same project appear in several workspaces through its threads", () => {
    const ctx = context({ "e:one": ["workspace:yt"], "e:two": ["workspace:sir"] });
    expect(isThreadInWorkspace("yt", "e:one", null, ctx)).toBe(true);
    expect(isThreadInWorkspace("sir", "e:two", null, ctx)).toBe(true);
    expect(isThreadInWorkspace("yt", "e:two", null, ctx)).toBe(false);
  });
});

describe("moveThreadTagChanges", () => {
  it("swaps the old workspace tag for the new one", () => {
    expect(moveThreadTagChanges(["x", "workspace:yt"], "sir", "def")).toEqual([
      { tag: "workspace:sir", tagged: true },
      { tag: "workspace:yt", tagged: false },
    ]);
  });

  it("moves to the default workspace by removing workspace tags only", () => {
    expect(moveThreadTagChanges(["x", "workspace:yt"], "def", "def")).toEqual([
      { tag: "workspace:yt", tagged: false },
    ]);
  });

  it("changes nothing when the thread is already only there", () => {
    expect(moveThreadTagChanges(["workspace:sir"], "sir", "def")).toEqual([]);
  });

  it("also clears tags of deleted workspaces", () => {
    expect(moveThreadTagChanges(["workspace:gone"], "sir", "def")).toEqual([
      { tag: "workspace:sir", tagged: true },
      { tag: "workspace:gone", tagged: false },
    ]);
  });
});

describe("reorderWorkspaces", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves before another workspace or to the end", () => {
    expect(reorderWorkspaces(list, "c", "a").map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(reorderWorkspaces(list, "a", null).map((w) => w.id)).toEqual(["b", "c", "a"]);
  });
  it("leaves the list alone for unknown ids", () => {
    expect(reorderWorkspaces(list, "x", "a").map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(reorderWorkspaces(list, "a", "x").map((w) => w.id)).toEqual(["a", "b", "c"]);
  });
});

describe("pickWorkspaceForWindow", () => {
  it("prefers the window's own, then the remembered, then any free workspace", () => {
    const ids = ["a", "b", "c"];
    expect(pickWorkspaceForWindow({ ids, sessionId: "b", rememberedId: "c", busyIds: [] })).toBe(
      "b",
    );
    expect(pickWorkspaceForWindow({ ids, sessionId: null, rememberedId: "c", busyIds: [] })).toBe(
      "c",
    );
    expect(
      pickWorkspaceForWindow({ ids, sessionId: null, rememberedId: "a", busyIds: ["a"] }),
    ).toBe("b");
    expect(
      pickWorkspaceForWindow({ ids, sessionId: null, rememberedId: null, busyIds: ids }),
    ).toBeNull();
  });
});
