import { describe, expect, it } from "vite-plus/test";

import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarSection,
} from "../components/Sidebar.logic";
import {
  buildSidebarProjectThreadGroups,
  isSidebarProjectDropAllowed,
  mergeProjectOrder,
  moveProjectKey,
  projectDropIndex,
} from "./sidebarProjectGroups.logic";

describe("project-grouped sidebar", () => {
  type T = { key: string; project: string };
  const thread = (key: string, project: string): T => ({ key, project });
  const build = (
    threads: readonly T[],
    options: {
      collapsed?: readonly string[];
      showAll?: readonly string[];
      routeThreadKey?: string | null;
    } = {},
  ) =>
    buildSidebarProjectThreadGroups({
      threads,
      projectKeyOf: (t) => t.project,
      threadKeyOf: (t) => t.key,
      projectOrder: ["b", "a"],
      isExpanded: (key) => !(options.collapsed ?? []).includes(key),
      showAllProjectKeys: new Set(options.showAll ?? []),
      routeThreadKey: options.routeThreadKey ?? null,
    });
  const many = Array.from({ length: 7 }, (_, i) => thread(`a${i}`, "a"));

  it("orders groups by project order, keeps thread order, and pages at five", () => {
    const groups = build([
      thread("a0", "a"),
      thread("b0", "b"),
      ...many.slice(1),
      thread("x", "z"),
    ]);
    expect(groups.map((g) => g.projectKey)).toEqual(["b", "a", "z"]);
    const a = groups[1]!;
    expect(a.visibleThreads.map((t) => t.key)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(a.hiddenCount).toBe(2);
    expect(build(many, { showAll: ["a"] })[0]!.hiddenCount).toBe(0);
  });

  it("keeps the open thread visible past the first page and in a collapsed project", () => {
    expect(build(many, { routeThreadKey: "a6" })[0]!.visibleThreads.map((t) => t.key)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "a6",
    ]);
    const collapsed = build(many, { collapsed: ["a"], routeThreadKey: "a2" })[0]!;
    expect(collapsed.visibleThreads.map((t) => t.key)).toEqual(["a2"]);
    expect(collapsed.hiddenCount).toBe(6);
    expect(build(many, { collapsed: ["a"] })[0]!.visibleThreads).toEqual([]);
  });

  describe("dragging", () => {
    const row = (key: string, section: SidebarSection, projectKey: string): SidebarListItem => ({
      kind: "thread",
      key,
      section,
      projectKey,
    });
    // Canonical order interleaves projects and includes the hidden a3.
    const canonical = ["a1", "b1", "a2", "a3"];
    const items: readonly SidebarListItem[] = [
      { kind: "marker", marker: "pinned-header" },
      row("p1", "pinned", "a"),
      { kind: "marker", marker: "pinned-divider" },
      {
        kind: "project-header",
        projectKey: "a",
        expanded: true,
        threadCount: 3,
        canonicalActiveOrder: canonical,
      },
      row("a1", "active", "a"),
      row("a2", "active", "a"),
      { kind: "project-more", projectKey: "a", hiddenCount: 1 },
      {
        kind: "project-header",
        projectKey: "b",
        expanded: true,
        threadCount: 1,
        canonicalActiveOrder: canonical,
      },
      row("b1", "active", "b"),
      { kind: "marker", marker: "settled-header" },
    ];
    it("limits active reorders to the row's own project", () => {
      expect(isSidebarProjectDropAllowed(items, "a1", "a2")).toBe(true);
      expect(isSidebarProjectDropAllowed(items, "a1", "b1")).toBe(false);
      expect(isSidebarProjectDropAllowed(items, "a1", sidebarListItemId(items[3]!))).toBe(false);
      expect(isSidebarProjectDropAllowed(items, "a1", "p1")).toBe(true);
      expect(isSidebarProjectDropAllowed(items, "a1", sidebarMarkerId("settled-header"))).toBe(
        true,
      );
      expect(isSidebarProjectDropAllowed(items, "p1", "b1")).toBe(true);
    });

    it("moves only the dragged row inside the canonical order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "a2")?.activeOrder).toEqual([
        "b1",
        "a2",
        "a1",
        "a3",
      ]);
      expect(resolveSidebarDropTarget(items, "a2", "a1")?.activeOrder).toEqual([
        "a2",
        "a1",
        "b1",
        "a3",
      ]);
      // A pinned row dropped on a project row lands beside it.
      expect(resolveSidebarDropTarget(items, "p1", "a1")?.activeOrder).toEqual([
        "a1",
        "p1",
        "b1",
        "a2",
        "a3",
      ]);
    });
  });
});

describe("manual project order", () => {
  it("keeps the saved order and appends new projects", () => {
    expect(mergeProjectOrder([], ["a", "b"])).toEqual(["a", "b"]);
    expect(mergeProjectOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    const saved = ["b", "a"];
    expect(mergeProjectOrder(saved, ["a"])).toBe(saved);
  });

  it("moves a key among the visible keys and keeps hidden keys in place", () => {
    expect(moveProjectKey(["a", "b", "c"], ["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveProjectKey(["a", "b", "c"], ["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveProjectKey(["a", "x", "b", "c"], ["a", "b", "c"], "c", 0)).toEqual([
      "c",
      "x",
      "a",
      "b",
    ]);
    const order = ["a", "b"];
    expect(moveProjectKey(order, ["a", "b"], "a", 0)).toBe(order);
  });

  it("finds the drop index from the pointer", () => {
    const groups = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
    ];
    expect(projectDropIndex(groups, 10)).toBe(0);
    expect(projectDropIndex(groups, 120)).toBe(1);
    expect(projectDropIndex(groups, 180)).toBe(2);
  });
});
