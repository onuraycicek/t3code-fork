import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Pure helpers for the split chat layout: a binary tree of splits whose leaves
 * are tab groups. Each leaf holds server-thread tabs (one thread is open in at
 * most one tab of the window) and shows its active tab, or nothing yet (an empty
 * pane waiting for a thread). Modeled on Orca's tab-group layout tree:
 * `horizontal` puts the two children side by side, `vertical` stacks them, and
 * `ratio` is the share of the axis given to `first`.
 *
 * Recency is a window-wide list of thread keys (most recent first), kept next to
 * the tree; it picks the tab that takes over when one closes and feeds the
 * Ctrl+Tab switcher.
 */

export type ChatPaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type PaneEdge = "left" | "right" | "top" | "bottom";
export type PaneDropZone = PaneEdge | "center";

export interface ChatPaneLeaf {
  readonly kind: "leaf";
  readonly id: ChatPaneId;
  /** Open tabs in strip order. Empty while the pane offers a thread picker. */
  readonly tabs: readonly ScopedThreadRef[];
  /** Thread key of the shown tab; null only when `tabs` is empty. */
  readonly activeKey: string | null;
}

export interface ChatPaneSplit {
  readonly kind: "split";
  readonly id: ChatPaneId;
  readonly direction: SplitDirection;
  readonly first: ChatPaneNode;
  readonly second: ChatPaneNode;
  readonly ratio: number;
}

export type ChatPaneNode = ChatPaneLeaf | ChatPaneSplit;

export const MIN_PANE_RATIO = 0.15;
export const MAX_PANE_RATIO = 0.85;
/** Outer share of a pane that turns a drop into a split on that edge. */
const EDGE_ZONE_FRACTION = 0.2;

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

export function collectLeaves(node: ChatPaneNode): ChatPaneLeaf[] {
  return node.kind === "leaf"
    ? [node]
    : [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function findNode(node: ChatPaneNode, id: ChatPaneId): ChatPaneNode | null {
  if (node.id === id) return node;
  if (node.kind === "leaf") return null;
  return findNode(node.first, id) ?? findNode(node.second, id);
}

export function findLeaf(node: ChatPaneNode, id: ChatPaneId): ChatPaneLeaf | null {
  const found = findNode(node, id);
  return found?.kind === "leaf" ? found : null;
}

export function createLeaf(
  id: ChatPaneId,
  tabs: readonly ScopedThreadRef[] = [],
  activeKey?: string | null,
): ChatPaneLeaf {
  const resolved =
    activeKey && tabs.some((tab) => scopedThreadKey(tab) === activeKey)
      ? activeKey
      : tabs[0]
        ? scopedThreadKey(tabs[0])
        : null;
  return { kind: "leaf", id, tabs, activeKey: resolved };
}

/** The thread the pane shows, if any. */
export function leafActiveThread(leaf: ChatPaneLeaf): ScopedThreadRef | null {
  if (leaf.activeKey === null) return null;
  return leaf.tabs.find((tab) => scopedThreadKey(tab) === leaf.activeKey) ?? null;
}

/** The pane holding a tab for `threadKey`, if any. */
export function findLeafByThreadKey(node: ChatPaneNode, threadKey: string): ChatPaneLeaf | null {
  return (
    collectLeaves(node).find((leaf) =>
      leaf.tabs.some((tab) => scopedThreadKey(tab) === threadKey),
    ) ?? null
  );
}

/** The pane holding a tab for `threadRef`, if any. */
export function findLeafByThread(
  node: ChatPaneNode,
  threadRef: ScopedThreadRef,
): ChatPaneLeaf | null {
  return findLeafByThreadKey(node, scopedThreadKey(threadRef));
}

function edgeToSplit(edge: PaneEdge): { direction: SplitDirection; side: "first" | "second" } {
  switch (edge) {
    case "left":
      return { direction: "horizontal", side: "first" };
    case "right":
      return { direction: "horizontal", side: "second" };
    case "top":
      return { direction: "vertical", side: "first" };
    case "bottom":
      return { direction: "vertical", side: "second" };
  }
}

function mapTree(
  node: ChatPaneNode,
  visit: (node: ChatPaneNode) => ChatPaneNode | undefined,
): ChatPaneNode {
  const replaced = visit(node);
  if (replaced !== undefined) return replaced;
  if (node.kind === "leaf") return node;
  const first = mapTree(node.first, visit);
  const second = mapTree(node.second, visit);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Wraps the node `targetId` in a 50/50 split with `newLeaf` on the `edge` side. */
export function splitPane(
  root: ChatPaneNode,
  targetId: ChatPaneId,
  edge: PaneEdge,
  newLeaf: ChatPaneLeaf,
  splitId: ChatPaneId,
): ChatPaneNode {
  const { direction, side } = edgeToSplit(edge);
  return mapTree(root, (node) =>
    node.id === targetId
      ? {
          kind: "split",
          id: splitId,
          direction,
          ratio: 0.5,
          first: side === "first" ? newLeaf : node,
          second: side === "first" ? node : newLeaf,
        }
      : undefined,
  );
}

/** Removes a leaf; its sibling takes the parent's slot. The last leaf leaves null. */
export function removePane(root: ChatPaneNode, paneId: ChatPaneId): ChatPaneNode | null {
  if (root.id === paneId) return null;
  if (root.kind === "leaf") return root;
  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/**
 * The pane that should take focus after `paneId` closes: its sibling, or the
 * sibling subtree's first leaf, as Orca does.
 */
export function findSiblingLeaf(root: ChatPaneNode, paneId: ChatPaneId): ChatPaneLeaf | null {
  if (root.kind === "leaf") return null;
  if (root.first.id === paneId) return collectLeaves(root.second)[0] ?? null;
  if (root.second.id === paneId) return collectLeaves(root.first)[0] ?? null;
  return findSiblingLeaf(root.first, paneId) ?? findSiblingLeaf(root.second, paneId);
}

export function setPaneRatio(root: ChatPaneNode, splitId: ChatPaneId, ratio: number): ChatPaneNode {
  const clamped = clampPaneRatio(ratio);
  return mapTree(root, (node) =>
    node.id === splitId && node.kind === "split"
      ? node.ratio === clamped
        ? node
        : { ...node, ratio: clamped }
      : undefined,
  );
}

/**
 * Moves pane `sourceId` beside `targetId` on `edge`. The source keeps its id,
 * so its mounted view and focus survive the move.
 */
export function movePane(
  root: ChatPaneNode,
  sourceId: ChatPaneId,
  targetId: ChatPaneId,
  edge: PaneEdge,
  splitId: ChatPaneId,
): ChatPaneNode {
  const source = findLeaf(root, sourceId);
  if (!source || sourceId === targetId) return root;
  const without = removePane(root, sourceId);
  if (!without || !findNode(without, targetId)) return root;
  return splitPane(without, targetId, edge, source, splitId);
}

/**
 * Where a drop lands on a pane, Orca style: the outer 20% of the width splits
 * left/right, the outer 20% of the height splits top/bottom, the rest joins the
 * pane's tabs. `headerHeight` keeps the pane's own strip out of the
 * top/bottom bands.
 */
export function resolvePaneDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  headerHeight = 0,
): PaneDropZone | null {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;
  const relX = x / rect.width;
  if (relX < EDGE_ZONE_FRACTION) return "left";
  if (relX > 1 - EDGE_ZONE_FRACTION) return "right";
  const bodyHeight = rect.height - headerHeight;
  const bodyY = y - headerHeight;
  if (bodyHeight > 0 && bodyY >= 0) {
    const relY = bodyY / bodyHeight;
    if (relY < EDGE_ZONE_FRACTION) return "top";
    if (relY > 1 - EDGE_ZONE_FRACTION) return "bottom";
  }
  return "center";
}

/** The half of `rect` a drop on `zone` will occupy, or the whole rect for center. */
export function dropPreviewRect(
  rect: { left: number; top: number; width: number; height: number },
  zone: PaneDropZone,
): { left: number; top: number; width: number; height: number } {
  // Copy explicitly: a DOMRect's fields are prototype getters, so spreading it drops them.
  const { left, top, width, height } = rect;
  switch (zone) {
    case "left":
      return { left, top, width: width / 2, height };
    case "right":
      return { left: left + width / 2, top, width: width / 2, height };
    case "top":
      return { left, top, width, height: height / 2 };
    case "bottom":
      return { left, top: top + height / 2, width, height: height / 2 };
    case "center":
      return { left, top, width, height };
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const THREAD_HISTORY_LIMIT = 100;

/** Moves `threadKey` to the front of a recency list. */
export function touchHistory(history: readonly string[], threadKey: string): readonly string[] {
  if (history[0] === threadKey) return history;
  return [threadKey, ...history.filter((key) => key !== threadKey)].slice(0, THREAD_HISTORY_LIMIT);
}

function replaceLeaf(root: ChatPaneNode, leaf: ChatPaneLeaf): ChatPaneNode {
  return mapTree(root, (node) => (node.id === leaf.id ? leaf : undefined));
}

/**
 * The tab that takes over after `removedIndex` closed: the most recently used
 * remaining tab of the pane, else the neighbor that slid into its place.
 */
export function pickActiveAfterRemoval(
  remaining: readonly ScopedThreadRef[],
  removedIndex: number,
  history: readonly string[],
): string | null {
  if (remaining.length === 0) return null;
  const keys = new Set(remaining.map((tab) => scopedThreadKey(tab)));
  const recent = history.find((key) => keys.has(key));
  if (recent) return recent;
  const neighbor = remaining[Math.min(removedIndex, remaining.length - 1)];
  return neighbor ? scopedThreadKey(neighbor) : null;
}

/** Makes `threadKey` the shown tab of `paneId` (no-op if the pane lacks it). */
export function activateTab(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  threadKey: string,
): ChatPaneNode {
  const leaf = findLeaf(root, paneId);
  if (!leaf || leaf.activeKey === threadKey) return root;
  if (!leaf.tabs.some((tab) => scopedThreadKey(tab) === threadKey)) return root;
  return replaceLeaf(root, { ...leaf, activeKey: threadKey });
}

/**
 * Adds `threadRef` as a tab of `paneId` (at `index`, default the end) and makes
 * it active. A tab already in that pane is just activated; one open in another
 * pane is not touched here (callers detach it first).
 */
export function insertTab(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  threadRef: ScopedThreadRef,
  index?: number,
): ChatPaneNode {
  const leaf = findLeaf(root, paneId);
  if (!leaf) return root;
  const key = scopedThreadKey(threadRef);
  if (leaf.tabs.some((tab) => scopedThreadKey(tab) === key)) {
    return activateTab(root, paneId, key);
  }
  const at =
    index === undefined ? leaf.tabs.length : Math.max(0, Math.min(index, leaf.tabs.length));
  const tabs = [...leaf.tabs.slice(0, at), threadRef, ...leaf.tabs.slice(at)];
  return replaceLeaf(root, { ...leaf, tabs, activeKey: key });
}

/** Removes a tab; the pane stays even when it ends up empty. */
export function removeTab(
  root: ChatPaneNode,
  threadKey: string,
  history: readonly string[],
): ChatPaneNode {
  const leaf = findLeafByThreadKey(root, threadKey);
  if (!leaf) return root;
  const index = leaf.tabs.findIndex((tab) => scopedThreadKey(tab) === threadKey);
  const tabs = leaf.tabs.filter((tab) => scopedThreadKey(tab) !== threadKey);
  const activeKey =
    leaf.activeKey === threadKey
      ? pickActiveAfterRemoval(
          tabs,
          index,
          history.filter((key) => key !== threadKey),
        )
      : leaf.activeKey;
  return replaceLeaf(root, { ...leaf, tabs, activeKey });
}

/**
 * Closes a tab. A pane left empty closes too, unless it is the only pane,
 * which stays as an empty picker.
 */
export function closeTab(
  root: ChatPaneNode,
  threadKey: string,
  history: readonly string[],
): ChatPaneNode {
  const leaf = findLeafByThreadKey(root, threadKey);
  if (!leaf) return root;
  const next = removeTab(root, threadKey, history);
  const emptied = findLeaf(next, leaf.id);
  if (emptied && emptied.tabs.length === 0) return removePane(next, leaf.id) ?? next;
  return next;
}

/** Index in the pane's strip where a drop at `clientX` inserts, given tab midpoints. */
export function resolveTabDropIndex(midpoints: readonly number[], clientX: number): number {
  const index = midpoints.findIndex((mid) => clientX < mid);
  return index < 0 ? midpoints.length : index;
}

/**
 * Moves a tab into `targetId`'s strip at `index` (an index into the strip as
 * it looks before the move). A source pane left empty closes.
 */
export function moveTabToPane(
  root: ChatPaneNode,
  threadKey: string,
  targetId: ChatPaneId,
  index: number | undefined,
  history: readonly string[],
): ChatPaneNode {
  const source = findLeafByThreadKey(root, threadKey);
  const target = findLeaf(root, targetId);
  if (!source || !target) return root;
  const ref = source.tabs.find((tab) => scopedThreadKey(tab) === threadKey)!;
  let at = index;
  if (source.id === target.id && at !== undefined) {
    const from = source.tabs.indexOf(ref);
    if (from < at) at -= 1;
    if (from === at) return activateTab(root, targetId, threadKey);
  }
  let next = removeTab(root, threadKey, history);
  if (source.id !== target.id) {
    const emptied = findLeaf(next, source.id);
    if (emptied && emptied.tabs.length === 0) next = removePane(next, source.id) ?? next;
  }
  return insertTab(next, targetId, ref, at);
}

/**
 * Moves a tab into a new pane beside `targetId` on `edge`. A tab alone in its
 * pane cannot split off its own pane. A source pane left empty closes.
 */
export function moveTabToEdge(
  root: ChatPaneNode,
  threadKey: string,
  targetId: ChatPaneId,
  edge: PaneEdge,
  history: readonly string[],
  newPaneId: ChatPaneId,
  splitId: ChatPaneId,
): ChatPaneNode {
  const source = findLeafByThreadKey(root, threadKey);
  if (!source || !findNode(root, targetId)) return root;
  if (source.id === targetId && source.tabs.length === 1) return root;
  const ref = source.tabs.find((tab) => scopedThreadKey(tab) === threadKey)!;
  let next = removeTab(root, threadKey, history);
  const emptied = findLeaf(next, source.id);
  if (emptied && emptied.tabs.length === 0) next = removePane(next, source.id) ?? next;
  if (!findNode(next, targetId)) return root;
  return splitPane(next, targetId, edge, createLeaf(newPaneId, [ref], threadKey), splitId);
}

/**
 * The window-wide recency order for the Ctrl+Tab switcher: tabs that are open,
 * most recently used first, then any open tab never visited in tree order.
 */
export function buildCycleOrder(root: ChatPaneNode, history: readonly string[]): string[] {
  const open = collectLeaves(root).flatMap((leaf) => leaf.tabs.map((tab) => scopedThreadKey(tab)));
  const openSet = new Set(open);
  const ordered = history.filter((key) => openSet.has(key));
  const seen = new Set(ordered);
  return [...ordered, ...open.filter((key) => !seen.has(key))];
}

/** Next index in a Ctrl+Tab walk; wraps around either way. */
export function stepCycleIndex(index: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  return (index + direction + length) % length;
}

/**
 * Housekeeping for tabs opened from a draft route (tracked by thread key): a
 * tab whose thread now exists on the server was promoted and needs no tracking
 * any more; one that is neither a live draft session nor a server thread is
 * stale (its draft was discarded) and closes. Keys not open as tabs just drop.
 */
export function resolveDraftTabCleanup(input: {
  draftTabKeys: readonly string[];
  openKeys: ReadonlySet<string>;
  draftSessionKeys: ReadonlySet<string>;
  serverKeys: ReadonlySet<string>;
}): { untrack: string[]; close: string[] } {
  const untrack: string[] = [];
  const close: string[] = [];
  for (const key of input.draftTabKeys) {
    if (!input.openKeys.has(key) || input.serverKeys.has(key)) {
      untrack.push(key);
    } else if (!input.draftSessionKeys.has(key)) {
      untrack.push(key);
      close.push(key);
    }
  }
  return { untrack, close };
}
