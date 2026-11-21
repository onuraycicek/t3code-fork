import {
  forkWorkspaceIdsFromTags,
  forkWorkspaceTag,
  type ScopedThreadRef,
} from "@t3tools/contracts";

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
 * Upstream's muted "Waiting" pill: the run ended but subagents or awaited background
 * work are still going, or the thread waits on another thread. Work is in progress.
 */
export function isBackgroundWorkPill(pill: ThreadStatusPill | null): boolean {
  return pill !== null && pill.dotClass.includes("bg-sidebar-muted-foreground");
}

/**
 * Buckets a tab-strip status pill for the workspace list. Keyed on the pill's dot
 * colour so the list always matches the strip; background work counts as working.
 */
export function classifyStatusPill(pill: ThreadStatusPill | null): TabActivity | null {
  if (!pill) return null;
  const dot = pill.dotClass;
  if (dot.includes("bg-sky") || isBackgroundWorkPill(pill)) return "run";
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

/** Moves `id` before `beforeId` (last when null); unknown ids leave the list as is. */
export function reorderWorkspaces<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  beforeId: string | null,
): T[] {
  const moving = items.find((item) => item.id === id);
  if (!moving) return [...items];
  const rest = items.filter((item) => item.id !== id);
  const index = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
  if (index < 0) return [...items];
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}

export interface WorkspaceMembershipContext {
  /** Workspace ids in the registry; tags naming any other id are ignored. */
  readonly knownIds: ReadonlySet<string>;
  /** Holds threads without a known workspace tag. */
  readonly defaultId: string | null;
  /** Thread tags by scoped thread key. */
  readonly tagsByKey: ReadonlyMap<string, ReadonlyArray<string>>;
}

function knownWorkspaceIds(
  threadKey: string | null,
  context: WorkspaceMembershipContext,
): string[] {
  if (threadKey === null) return [];
  return forkWorkspaceIdsFromTags(context.tagsByKey.get(threadKey)).filter((id) =>
    context.knownIds.has(id),
  );
}

/**
 * The workspaces a thread belongs to. A subagent follows its root thread; a thread with
 * no known workspace tag (untagged, or its workspace was deleted) belongs to the
 * default one, so no thread is ever left without a workspace.
 */
export function threadWorkspaceIds(
  threadKey: string,
  rootThreadKey: string | null,
  context: WorkspaceMembershipContext,
): string[] {
  const fromRoot = rootThreadKey === threadKey ? [] : knownWorkspaceIds(rootThreadKey, context);
  const ids = fromRoot.length > 0 ? fromRoot : knownWorkspaceIds(threadKey, context);
  if (ids.length > 0) return ids;
  return context.defaultId === null ? [] : [context.defaultId];
}

export function isThreadInWorkspace(
  workspaceId: string,
  threadKey: string,
  rootThreadKey: string | null,
  context: WorkspaceMembershipContext,
): boolean {
  return threadWorkspaceIds(threadKey, rootThreadKey, context).includes(workspaceId);
}

/** Tag changes that make a thread a member of `targetId` only (no tag for the default). */
export function moveThreadTagChanges(
  currentTags: ReadonlyArray<string>,
  targetId: string,
  defaultId: string | null,
): { readonly tag: string; readonly tagged: boolean }[] {
  const target = targetId === defaultId ? null : forkWorkspaceTag(targetId);
  // Add before removing, so a half-done move never leaves the thread without its target.
  const changes: { tag: string; tagged: boolean }[] =
    target !== null && !currentTags.includes(target) ? [{ tag: target, tagged: true }] : [];
  for (const id of forkWorkspaceIdsFromTags(currentTags)) {
    const tag = forkWorkspaceTag(id);
    if (tag !== target) changes.push({ tag, tagged: false });
  }
  return changes;
}
