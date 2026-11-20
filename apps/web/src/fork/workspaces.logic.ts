import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadStatusPill } from "../components/Sidebar.logic";
import { closeTab, collectLeaves, findLeaf, findLeafByThreadKey } from "./chatPanes.logic";
import type { PaneLayout } from "./chatPanesStore";

/**
 * The workspace a window opens on: its own from before a reload, else the remembered
 * one (main window), else the first one no other window has open. Null when all are busy.
 */
export function pickWorkspaceForWindow(input: {
  readonly ids: readonly string[];
  readonly sessionId: string | null;
  readonly rememberedId: string | null;
  readonly busyIds: readonly string[];
}): string | null {
  const busy = new Set(input.busyIds);
  const usable = (id: string | null): id is string =>
    id !== null && input.ids.includes(id) && !busy.has(id);
  if (usable(input.sessionId)) return input.sessionId;
  if (usable(input.rememberedId)) return input.rememberedId;
  return input.ids.find((id) => !busy.has(id)) ?? null;
}

/** "Workspace N" with the lowest N not taken. */
export function nextWorkspaceName(names: readonly string[]): string {
  const taken = new Set(names);
  for (let n = 2; ; n += 1) {
    const name = `Workspace ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** A workspace's tabs in a fixed order: panes as laid out, tabs as in their strip. */
export function layoutTabs(layout: PaneLayout): ScopedThreadRef[] {
  return layout.root ? collectLeaves(layout.root).flatMap((leaf) => leaf.tabs) : [];
}

export type TabActivity = "wait" | "run" | "done" | "error";

/**
 * Buckets a tab-strip status pill for the workspace list. Keyed on the pill's dot
 * colour so the list always matches the strip; "Waiting" (muted) is no activity.
 */
export function classifyStatusPill(pill: ThreadStatusPill | null): TabActivity | null {
  if (!pill) return null;
  const dot = pill.dotClass;
  if (dot.includes("bg-sky")) return "run";
  if (dot.includes("bg-emerald")) return "done";
  if (dot.includes("bg-red")) return "error";
  if (dot.includes("bg-amber") || dot.includes("bg-indigo") || dot.includes("bg-violet")) {
    return "wait";
  }
  if (dot.includes("bg-guest")) return "wait";
  return null;
}

/**
 * An unsent draft belongs to one workspace: upstream keeps one draft per project, so
 * an empty workspace landing on the index reopens the same draft. Opening it in one
 * workspace takes it out of the others, so sending it never runs in two workspaces.
 */
export function withoutDraftTabs(layout: PaneLayout, draftKeys: readonly string[]): PaneLayout {
  let root = layout.root;
  let history = layout.history;
  for (const key of draftKeys) {
    if (!root || !findLeafByThreadKey(root, key)) continue;
    root = closeTab(root, key, history);
    history = history.filter((entry) => entry !== key);
  }
  if (root === layout.root) return layout;
  const focusedPaneId =
    root && layout.focusedPaneId && findLeaf(root, layout.focusedPaneId)
      ? layout.focusedPaneId
      : root
        ? collectLeaves(root)[0]!.id
        : null;
  const dropped = new Set(draftKeys);
  return {
    root,
    focusedPaneId,
    history,
    draftTabKeys: layout.draftTabKeys.filter((key) => !dropped.has(key)),
  };
}
