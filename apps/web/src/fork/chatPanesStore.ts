import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  clampPaneRatio,
  collectLeaves,
  findLeaf,
  findLeafByThread,
  findSiblingLeaf,
  movePane,
  pruneMissingThreads,
  removePane,
  setLeafThread,
  setPaneRatio,
  splitPane,
  swapLeafThreads,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type PaneEdge,
} from "./chatPanes.logic";
import { resolveStorage } from "../lib/storage";
import { randomUUID } from "../lib/utils";

/**
 * The window's split chat layout. Null means the plain single chat view. The
 * route stays the source of truth for the focused pane's thread: opening a
 * thread from anywhere either focuses the pane that already shows it or loads
 * it into the focused pane, like opening a file in Orca's focused tab group.
 */

const LeafSchema = Schema.Struct({
  kind: Schema.Literal("leaf"),
  id: Schema.String,
  threadRef: Schema.NullOr(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
});
const NodeSchema: Schema.Codec<ChatPaneNode> = Schema.Union([
  LeafSchema,
  Schema.Struct({
    kind: Schema.Literal("split"),
    id: Schema.String,
    direction: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Finite,
    first: Schema.suspend(() => NodeSchema),
    second: Schema.suspend(() => NodeSchema),
  }),
]) as Schema.Codec<ChatPaneNode>;
const PersistedSchema = Schema.Struct({
  root: Schema.NullOr(NodeSchema),
  focusedPaneId: Schema.NullOr(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

interface ChatPanesState {
  root: ChatPaneNode | null;
  focusedPaneId: ChatPaneId | null;
  /** Mirrors the route into the layout: focus the pane showing it, else load it into the focused pane. */
  syncRouteThread: (threadRef: ScopedThreadRef) => void;
  focusPane: (paneId: ChatPaneId) => void;
  /**
   * Splits `targetId` (or, with no layout yet, a pane seeded with
   * `anchorThreadRef`) on `edge`, showing `threadRef` there. A null thread
   * opens an empty pane with a thread picker. The new pane takes focus.
   */
  split: (input: {
    targetId: ChatPaneId | null;
    anchorThreadRef: ScopedThreadRef | null;
    edge: PaneEdge;
    threadRef: ScopedThreadRef | null;
  }) => ChatPaneId | null;
  /** Shows `threadRef` in `paneId`; a thread already open elsewhere moves here. */
  setPaneThread: (paneId: ChatPaneId, threadRef: ScopedThreadRef) => void;
  /** Drag-and-drop: move a pane beside another, or swap their contents on center. */
  dropPane: (sourceId: ChatPaneId, targetId: ChatPaneId, zone: PaneEdge | "center") => void;
  /**
   * Closes a pane. Returns the thread the route should follow (the newly
   * focused pane's), or null when the route does not need to change.
   */
  closePane: (paneId: ChatPaneId) => ScopedThreadRef | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
  /** Clears panes whose thread no longer exists (deleted or archived elsewhere). */
  pruneThreads: (exists: (threadRef: ScopedThreadRef) => boolean) => void;
  reset: () => void;
}

function newLeaf(threadRef: ScopedThreadRef | null): ChatPaneLeaf {
  return { kind: "leaf", id: randomUUID(), threadRef };
}

function sameThread(a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean {
  if (a === null || b === null) return a === b;
  return scopedThreadKey(a) === scopedThreadKey(b);
}

/** A layout of one pane is just the plain chat view, so it collapses to null. */
function normalizeRoot(root: ChatPaneNode | null): ChatPaneNode | null {
  return root === null || root.kind === "leaf" ? null : root;
}

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set, get) => ({
      root: null,
      focusedPaneId: null,
      syncRouteThread: (threadRef) =>
        set((state) => {
          if (!state.root) return state;
          const existing = findLeafByThread(state.root, threadRef);
          if (existing) {
            return existing.id === state.focusedPaneId ? state : { focusedPaneId: existing.id };
          }
          const focused =
            (state.focusedPaneId && findLeaf(state.root, state.focusedPaneId)) ||
            collectLeaves(state.root)[0]!;
          return {
            root: setLeafThread(state.root, focused.id, threadRef),
            focusedPaneId: focused.id,
          };
        }),
      focusPane: (paneId) =>
        set((state) =>
          state.focusedPaneId === paneId || !state.root || !findLeaf(state.root, paneId)
            ? state
            : { focusedPaneId: paneId },
        ),
      split: ({ targetId, anchorThreadRef, edge, threadRef }) => {
        const state = get();
        let root = state.root;
        let target = targetId;
        if (!root) {
          if (!anchorThreadRef) return null;
          const anchor = newLeaf(anchorThreadRef);
          root = anchor;
          target = anchor.id;
        }
        if (!target || !findLeaf(root, target)) {
          target = state.focusedPaneId ?? collectLeaves(root)[0]!.id;
        }
        // A thread shows in one pane at most: splitting with an open thread moves it.
        if (threadRef) {
          const already = findLeafByThread(root, threadRef);
          if (already) {
            if (already.id === target) return already.id;
            root = removePane(root, already.id) ?? root;
          }
        }
        const leaf = newLeaf(threadRef);
        const next = normalizeRoot(splitPane(root, target, edge, leaf, randomUUID()));
        set({ root: next, focusedPaneId: next ? leaf.id : null });
        return leaf.id;
      },
      setPaneThread: (paneId, threadRef) =>
        set((state) => {
          if (!state.root || !findLeaf(state.root, paneId)) return state;
          let root: ChatPaneNode = state.root;
          const already = findLeafByThread(root, threadRef);
          if (already && already.id !== paneId) {
            root = removePane(root, already.id) ?? root;
          }
          root = setLeafThread(root, paneId, threadRef);
          return { root: normalizeRoot(root), focusedPaneId: paneId };
        }),
      dropPane: (sourceId, targetId, zone) =>
        set((state) => {
          if (!state.root || sourceId === targetId) return state;
          const root =
            zone === "center"
              ? swapLeafThreads(state.root, sourceId, targetId)
              : movePane(state.root, sourceId, targetId, zone, randomUUID());
          return root === state.root
            ? state
            : { root: normalizeRoot(root), focusedPaneId: sourceId };
        }),
      closePane: (paneId) => {
        const state = get();
        if (!state.root) return null;
        const closing = findLeaf(state.root, paneId);
        if (!closing) return null;
        const sibling = findSiblingLeaf(state.root, paneId);
        const remaining = removePane(state.root, paneId);
        const wasFocused = state.focusedPaneId === paneId;
        const nextFocusId = wasFocused
          ? (sibling?.id ?? (remaining ? collectLeaves(remaining)[0]!.id : null))
          : state.focusedPaneId;
        const nextFocus = remaining && nextFocusId ? findLeaf(remaining, nextFocusId) : null;
        const nextRoot = normalizeRoot(remaining);
        set({ root: nextRoot, focusedPaneId: nextRoot ? (nextFocus?.id ?? null) : null });
        // The route follows focus when the focused pane closed, and always when
        // the layout collapses back to one pane so the plain view shows it.
        const survivor = nextFocus?.threadRef ?? null;
        if (wasFocused || normalizeRoot(remaining) === null) return survivor;
        return null;
      },
      setRatio: (splitId, ratio) =>
        set((state) => {
          if (!state.root) return state;
          const root = setPaneRatio(state.root, splitId, clampPaneRatio(ratio));
          return root === state.root ? state : { root };
        }),
      pruneThreads: (exists) =>
        set((state) => {
          if (!state.root) return state;
          const root = pruneMissingThreads(state.root, exists);
          return root === state.root ? state : { root };
        }),
      reset: () => set({ root: null, focusedPaneId: null }),
    }),
    {
      name: "t3code:fork-chat-panes:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ root: state.root, focusedPaneId: state.focusedPaneId }),
      merge: (persisted, current) => {
        try {
          const { root, focusedPaneId } = decodePersisted(persisted);
          const normalized = normalizeRoot(root);
          const focused =
            normalized && focusedPaneId && findLeaf(normalized, focusedPaneId)
              ? focusedPaneId
              : normalized
                ? collectLeaves(normalized)[0]!.id
                : null;
          return { ...current, root: normalized, focusedPaneId: focused };
        } catch {
          return current;
        }
      },
    },
  ),
);

/** The focused pane's thread, which the route should show. */
export function selectFocusedPaneThread(state: Pick<ChatPanesState, "root" | "focusedPaneId">) {
  if (!state.root || !state.focusedPaneId) return null;
  return findLeaf(state.root, state.focusedPaneId)?.threadRef ?? null;
}

export { sameThread as sameChatPaneThread };

/**
 * Opens `threadRef` (or an empty pane when null) beside the focused pane, or
 * beside `anchorThreadRef` when there is no layout yet. Returns false when the
 * thread is the anchor itself with no layout, which has nothing to split.
 */
export function openChatPaneSplit(
  anchorThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef | null,
  edge: PaneEdge = "right",
): boolean {
  const state = useChatPanesStore.getState();
  if (!state.root && threadRef && anchorThreadRef && sameThread(threadRef, anchorThreadRef)) {
    return false;
  }
  return (
    state.split({
      targetId: state.focusedPaneId,
      anchorThreadRef,
      edge,
      threadRef,
    }) !== null
  );
}
