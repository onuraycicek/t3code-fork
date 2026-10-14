import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Pure helpers for the split chat layout: a binary tree of splits whose leaves
 * each show one server thread, or nothing yet (an empty pane waiting for a
 * thread). Modeled on Orca's tab-group layout tree: `horizontal` puts the two
 * children side by side, `vertical` stacks them, and `ratio` is the share of
 * the axis given to `first`.
 */

export type ChatPaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type PaneEdge = "left" | "right" | "top" | "bottom";
export type PaneDropZone = PaneEdge | "center";

export interface ChatPaneLeaf {
  readonly kind: "leaf";
  readonly id: ChatPaneId;
  /** Null while the pane is empty and offers a thread picker. */
  readonly threadRef: ScopedThreadRef | null;
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

/** The pane showing `threadRef`, if any. */
export function findLeafByThread(
  node: ChatPaneNode,
  threadRef: ScopedThreadRef,
): ChatPaneLeaf | null {
  const key = scopedThreadKey(threadRef);
  return (
    collectLeaves(node).find(
      (leaf) => leaf.threadRef !== null && scopedThreadKey(leaf.threadRef) === key,
    ) ?? null
  );
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

export function setLeafThread(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  threadRef: ScopedThreadRef | null,
): ChatPaneNode {
  return mapTree(root, (node) =>
    node.id === paneId && node.kind === "leaf" ? { ...node, threadRef } : undefined,
  );
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

/** Swaps what two panes show, keeping the layout itself. */
export function swapLeafThreads(
  root: ChatPaneNode,
  aId: ChatPaneId,
  bId: ChatPaneId,
): ChatPaneNode {
  const a = findLeaf(root, aId);
  const b = findLeaf(root, bId);
  if (!a || !b || a.id === b.id) return root;
  return mapTree(root, (node) => {
    if (node.id === a.id) return { ...a, threadRef: b.threadRef };
    if (node.id === b.id) return { ...b, threadRef: a.threadRef };
    return undefined;
  });
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

/** Every pane's thread is still showable; empty panes always are. */
export function pruneMissingThreads(
  root: ChatPaneNode,
  exists: (threadRef: ScopedThreadRef) => boolean,
): ChatPaneNode {
  return mapTree(root, (node) =>
    node.kind === "leaf" && node.threadRef !== null && !exists(node.threadRef)
      ? { ...node, threadRef: null }
      : undefined,
  );
}

/**
 * Where a drop lands on a pane, Orca style: the outer 20% of the width splits
 * left/right, the outer 20% of the height splits top/bottom, the rest replaces
 * the pane's content. `headerHeight` keeps the pane's own strip out of the
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
