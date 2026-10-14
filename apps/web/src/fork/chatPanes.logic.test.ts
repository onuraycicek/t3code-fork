import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activateTab,
  buildCycleOrder,
  closeTab,
  collectLeaves,
  createLeaf,
  findLeaf,
  findLeafByThreadKey,
  insertTab,
  leafActiveThread,
  moveTabToEdge,
  moveTabToPane,
  pickActiveAfterRemoval,
  removeTab,
  resolveDraftTabCleanup,
  resolveTabDropIndex,
  splitPane,
  stepCycleIndex,
  touchHistory,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "./chatPanes.logic";

const env = EnvironmentId.make("env");
const ref = (id: string): ScopedThreadRef => ({
  environmentId: env,
  threadId: ThreadId.make(id),
});
const key = (id: string) => `${env}:${id}`;
const tabIds = (leaf: ChatPaneLeaf | null) => leaf?.tabs.map((tab) => tab.threadId as string);

function twoPanes(): ChatPaneNode {
  // pane A: a, b, c (b active)   pane B: d, e
  const a = createLeaf("A", [ref("a"), ref("b"), ref("c")], key("b"));
  const b = createLeaf("B", [ref("d"), ref("e")], key("d"));
  return splitPane(a, "A", "right", b, "S");
}

describe("tab model", () => {
  it("createLeaf defaults the active tab to the first", () => {
    const leaf = createLeaf("A", [ref("a"), ref("b")]);
    expect(leaf.activeKey).toBe(key("a"));
    expect(createLeaf("A").activeKey).toBeNull();
  });

  it("insertTab appends, activates, and does not duplicate", () => {
    let root: ChatPaneNode = createLeaf("A", [ref("a")]);
    root = insertTab(root, "A", ref("b"));
    root = insertTab(root, "A", ref("a"));
    const leaf = findLeaf(root, "A")!;
    expect(tabIds(leaf)).toEqual(["a", "b"]);
    expect(leaf.activeKey).toBe(key("a"));
    const at = findLeaf(insertTab(root, "A", ref("c"), 0), "A")!;
    expect(tabIds(at)).toEqual(["c", "a", "b"]);
  });

  it("activateTab ignores unknown tabs", () => {
    const root = createLeaf("A", [ref("a")]);
    expect(activateTab(root, "A", key("zzz"))).toBe(root);
  });

  it("closing the active tab picks the most recently used remaining tab", () => {
    const root = twoPanes();
    const next = removeTab(root, key("b"), [key("b"), key("d"), key("c"), key("a")]);
    expect(findLeaf(next, "A")!.activeKey).toBe(key("c"));
  });

  it("falls back to the neighbor without history", () => {
    expect(pickActiveAfterRemoval([ref("a"), ref("c")], 1, [])).toBe(key("c"));
    expect(pickActiveAfterRemoval([ref("a"), ref("c")], 2, [])).toBe(key("c"));
    expect(pickActiveAfterRemoval([], 0, [])).toBeNull();
  });

  it("closing a background tab keeps the active one", () => {
    const next = removeTab(twoPanes(), key("a"), []);
    expect(findLeaf(next, "A")!.activeKey).toBe(key("b"));
  });

  it("closing the last tab closes the pane, except the only pane", () => {
    let root = closeTab(twoPanes(), key("d"), []);
    root = closeTab(root, key("e"), []);
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe("A");
    let solo: ChatPaneNode = createLeaf("A", [ref("a")]);
    solo = closeTab(solo, key("a"), []);
    expect(solo.kind).toBe("leaf");
    expect(findLeaf(solo, "A")!.tabs).toHaveLength(0);
    expect(leafActiveThread(findLeaf(solo, "A")!)).toBeNull();
  });
});

describe("moving tabs", () => {
  it("reorders within a strip using the pre-move index", () => {
    const root = twoPanes();
    expect(tabIds(findLeaf(moveTabToPane(root, key("a"), "A", 3, []), "A"))).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(tabIds(findLeaf(moveTabToPane(root, key("c"), "A", 0, []), "A"))).toEqual([
      "c",
      "a",
      "b",
    ]);
    // Dropping a tab on its own slot changes nothing but the active tab.
    expect(tabIds(findLeaf(moveTabToPane(root, key("b"), "A", 2, []), "A"))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("moves a tab to another pane at an index and activates it there", () => {
    const next = moveTabToPane(twoPanes(), key("c"), "B", 1, []);
    const b = findLeaf(next, "B")!;
    expect(tabIds(b)).toEqual(["d", "c", "e"]);
    expect(b.activeKey).toBe(key("c"));
    expect(tabIds(findLeaf(next, "A"))).toEqual(["a", "b"]);
  });

  it("dragging the last tab out of a pane closes that pane", () => {
    const solo = createLeaf("B", [ref("d")]);
    const root = splitPane(createLeaf("A", [ref("a")]), "A", "right", solo, "S");
    const next = moveTabToPane(root, key("d"), "A", undefined, []);
    expect(next.kind).toBe("leaf");
    expect(tabIds(findLeaf(next, "A"))).toEqual(["a", "d"]);
  });

  it("splits a tab off beside a pane", () => {
    const next = moveTabToEdge(twoPanes(), key("e"), "A", "bottom", [], "N", "S2");
    const leaves = collectLeaves(next);
    expect(leaves.map((leaf) => leaf.id).toSorted()).toEqual(["A", "B", "N"]);
    expect(tabIds(findLeaf(next, "N"))).toEqual(["e"]);
    expect(tabIds(findLeaf(next, "B"))).toEqual(["d"]);
  });

  it("refuses to split the only tab of a pane off itself", () => {
    const root = createLeaf("A", [ref("a")]);
    expect(moveTabToEdge(root, key("a"), "A", "right", [], "N", "S")).toBe(root);
  });

  it("closes the source pane when its last tab splits away", () => {
    const solo = createLeaf("B", [ref("d")]);
    const root = splitPane(createLeaf("A", [ref("a"), ref("b")]), "A", "right", solo, "S");
    const next = moveTabToEdge(root, key("d"), "A", "left", [], "N", "S2");
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(["N", "A"]);
    expect(findLeafByThreadKey(next, key("d"))!.id).toBe("N");
  });
});

describe("recency", () => {
  it("touchHistory keeps unique keys most recent first", () => {
    expect(touchHistory(touchHistory(["a", "b"], "b"), "c")).toEqual(["c", "b", "a"]);
  });

  it("builds the cycle order from open tabs only, then unvisited tabs", () => {
    const order = buildCycleOrder(twoPanes(), [key("d"), key("gone"), key("b")]);
    expect(order).toEqual([key("d"), key("b"), key("a"), key("c"), key("e")]);
  });

  it("steps and wraps both ways", () => {
    expect(stepCycleIndex(0, 3, 1)).toBe(1);
    expect(stepCycleIndex(2, 3, 1)).toBe(0);
    expect(stepCycleIndex(0, 3, -1)).toBe(2);
  });

  it("resolves the drop index from tab midpoints", () => {
    expect(resolveTabDropIndex([50, 150, 250], 10)).toBe(0);
    expect(resolveTabDropIndex([50, 150, 250], 160)).toBe(2);
    expect(resolveTabDropIndex([50, 150, 250], 999)).toBe(3);
    expect(resolveTabDropIndex([], 5)).toBe(0);
  });
});

describe("draft tabs", () => {
  // A draft tab holds the reserved thread ref, so it is an ordinary tab.
  it("adds a draft as a new tab of the focused pane and focuses a repeat", () => {
    const added = insertTab(twoPanes(), "A", ref("draft"));
    expect(tabIds(findLeaf(added, "A"))).toEqual(["a", "b", "c", "draft"]);
    expect(findLeaf(added, "A")?.activeKey).toBe(key("draft"));
    expect(tabIds(findLeaf(added, "B"))).toEqual(["d", "e"]);
    const again = insertTab(activateTab(added, "A", key("a")), "A", ref("draft"));
    expect(tabIds(findLeaf(again, "A"))).toEqual(["a", "b", "c", "draft"]);
    expect(findLeaf(again, "A")?.activeKey).toBe(key("draft"));
  });

  it("promotion (same ref arriving as a server route) keeps the tab in place", () => {
    const withDraft = insertTab(twoPanes(), "A", ref("draft"), 1);
    const promoted = insertTab(withDraft, "A", ref("draft"));
    expect(tabIds(findLeaf(promoted, "A"))).toEqual(["a", "draft", "b", "c"]);
    expect(collectLeaves(promoted).flatMap((leaf) => leaf.tabs)).toHaveLength(6);
  });

  it("closing a draft tab only removes the tab", () => {
    const withDraft = insertTab(twoPanes(), "A", ref("draft"));
    const closed = closeTab(withDraft, key("draft"), [key("b")]);
    expect(tabIds(findLeaf(closed, "A"))).toEqual(["a", "b", "c"]);
    expect(findLeaf(closed, "A")?.activeKey).toBe(key("b"));
  });

  it("cleans up: promoted untracks, discarded drafts close, closed tabs untrack", () => {
    const result = resolveDraftTabCleanup({
      draftTabKeys: [key("live"), key("promoted"), key("gone"), key("closed")],
      openKeys: new Set([key("live"), key("promoted"), key("gone")]),
      draftSessionKeys: new Set([key("live")]),
      serverKeys: new Set([key("promoted")]),
    });
    expect(result.close).toEqual([key("gone")]);
    expect(result.untrack).toEqual([key("promoted"), key("gone"), key("closed")]);
  });
});
