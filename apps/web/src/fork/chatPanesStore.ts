import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  activateTab,
  clampPaneRatio,
  closeTab,
  collectLeaves,
  createLeaf,
  findLeaf,
  findLeafByThreadKey,
  findSiblingLeaf,
  insertTab,
  leafActiveThread,
  moveTabToEdge,
  moveTabToPane,
  removePane,
  setPaneRatio,
  splitPane,
  touchHistory,
  type ChatPaneId,
  type ChatPaneNode,
  type PaneEdge,
} from "./chatPanes.logic";
import { resolveStorage } from "../lib/storage";
import { randomUUID } from "../lib/utils";

/**
 * The window's chat layout: a tree of panes, each a tab group. Null means no
 * thread has been opened yet (the plain upstream view). The route stays the
 * source of truth for the focused pane's active tab: opening a thread from
 * anywhere either focuses the tab that already shows it or adds it as a new
 * tab of the focused pane. A layout of a single pane is kept (tabs without
 * splits).
 */

/** Pane id used for the pane created when the first thread opens. */
export const SEED_PANE_ID = "pane-seed";

const ThreadRefSchema = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });
const LeafSchema = Schema.Struct({
  kind: Schema.Literal("leaf"),
  id: Schema.String,
  tabs: Schema.Array(ThreadRefSchema),
  activeKey: Schema.NullOr(Schema.String),
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
  history: Schema.Array(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

const STORAGE_VERSION = 2;

/** v1 leaves held one `threadRef`; v2 leaves hold tabs. */
function migrateNode(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const record = node as Record<string, unknown>;
  if (record.kind === "split") {
    return { ...record, first: migrateNode(record.first), second: migrateNode(record.second) };
  }
  if (record.kind === "leaf" && !Array.isArray(record.tabs)) {
    const ref = record.threadRef as ScopedThreadRef | null | undefined;
    return {
      kind: "leaf",
      id: record.id,
      tabs: ref ? [ref] : [],
      activeKey: ref ? scopedThreadKey(ref) : null,
    };
  }
  return node;
}

function migratePersisted(persisted: unknown, version: number): unknown {
  if (version >= STORAGE_VERSION || typeof persisted !== "object" || persisted === null) {
    return persisted;
  }
  const record = persisted as Record<string, unknown>;
  return { ...record, root: migrateNode(record.root), history: [] };
}

/**
 * While a Ctrl+Tab walk is in progress the recency order stays frozen; the
 * walk commits its landing tab when the modifier is released.
 */
let historyFrozen = false;
export function freezeChatPaneHistory(frozen: boolean): void {
  historyFrozen = frozen;
}

interface ChatPanesState {
  root: ChatPaneNode | null;
  focusedPaneId: ChatPaneId | null;
  /** Thread keys, most recently used first. */
  history: readonly string[];
  /**
   * Mirrors the route into the layout: focus the tab showing it, else add it as
   * a new tab of the focused pane (creating the layout when there is none).
   */
  syncRouteThread: (threadRef: ScopedThreadRef) => void;
  focusPane: (paneId: ChatPaneId) => void;
  /** Shows the tab `threadKey` of `paneId` and focuses the pane. */
  activateTab: (paneId: ChatPaneId, threadKey: string) => void;
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
  /** Adds `threadRef` as the active tab of `paneId`; a thread open elsewhere moves here. */
  setPaneThread: (paneId: ChatPaneId, threadRef: ScopedThreadRef) => void;
  /**
   * Closes tabs. `keepKey` stays (and becomes active in its pane) for bulk
   * closes. Returns the thread the route should follow, or null when it need
   * not change.
   */
  closeTabs: (threadKeys: readonly string[], keepKey?: string) => ScopedThreadRef | null;
  /**
   * Drag-and-drop of a tab: into a pane's strip (`index`) or body, or beside a
   * pane on an edge. Returns the moved tab's thread (the route should follow).
   */
  dropTab: (
    threadKey: string,
    targetId: ChatPaneId,
    placement: { edge: PaneEdge } | { index?: number },
  ) => ScopedThreadRef | null;
  /** Records a visit (a finished Ctrl+Tab walk). */
  touch: (threadKey: string) => void;
  /**
   * Closes a pane with all its tabs. Returns the thread the route should follow
   * (the newly focused pane's), or null when the route does not need to change.
   * The only pane is emptied instead.
   */
  closePane: (paneId: ChatPaneId) => ScopedThreadRef | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
  reset: () => void;
}

function sameThread(a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean {
  if (a === null || b === null) return a === b;
  return scopedThreadKey(a) === scopedThreadKey(b);
}

function visit(history: readonly string[], key: string | null): readonly string[] {
  return key === null || historyFrozen ? history : touchHistory(history, key);
}

function pickFocusedLeaf(root: ChatPaneNode, focusedPaneId: ChatPaneId | null) {
  return (focusedPaneId && findLeaf(root, focusedPaneId)) || collectLeaves(root)[0]!;
}

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set, get) => ({
      root: null,
      focusedPaneId: null,
      history: [],
      syncRouteThread: (threadRef) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          if (!state.root) {
            return {
              root: createLeaf(SEED_PANE_ID, [threadRef], key),
              focusedPaneId: SEED_PANE_ID,
              history: visit(state.history, key),
            };
          }
          const existing = findLeafByThreadKey(state.root, key);
          const target = existing ?? pickFocusedLeaf(state.root, state.focusedPaneId);
          const root = existing
            ? activateTab(state.root, existing.id, key)
            : insertTab(state.root, target.id, threadRef);
          const history = visit(state.history, key);
          if (
            root === state.root &&
            state.focusedPaneId === target.id &&
            history === state.history
          ) {
            return state;
          }
          return { root, focusedPaneId: target.id, history };
        }),
      focusPane: (paneId) =>
        set((state) =>
          state.focusedPaneId === paneId || !state.root || !findLeaf(state.root, paneId)
            ? state
            : { focusedPaneId: paneId },
        ),
      activateTab: (paneId, threadKey) =>
        set((state) => {
          if (!state.root) return state;
          const root = activateTab(state.root, paneId, threadKey);
          return { root, focusedPaneId: paneId, history: visit(state.history, threadKey) };
        }),
      split: ({ targetId, anchorThreadRef, edge, threadRef }) => {
        const state = get();
        let root = state.root;
        let target = targetId;
        if (!root) {
          if (!anchorThreadRef) return null;
          root = createLeaf(SEED_PANE_ID, [anchorThreadRef]);
          target = SEED_PANE_ID;
        }
        if (!target || !findLeaf(root, target)) {
          target = state.focusedPaneId ?? collectLeaves(root)[0]!.id;
        }
        let history = state.history;
        const newId = randomUUID();
        if (threadRef) {
          const key = scopedThreadKey(threadRef);
          const source = findLeafByThreadKey(root, key);
          if (source) {
            // A thread is one tab at most: splitting with an open one moves it.
            const moved = moveTabToEdge(root, key, target, edge, history, newId, randomUUID());
            if (moved === root) return source.id;
            set({ root: moved, focusedPaneId: newId, history: visit(history, key) });
            return newId;
          }
          history = visit(history, key);
        }
        const leaf = createLeaf(newId, threadRef ? [threadRef] : []);
        const next = splitPane(root, target, edge, leaf, randomUUID());
        set({ root: next, focusedPaneId: newId, history });
        return newId;
      },
      setPaneThread: (paneId, threadRef) =>
        set((state) => {
          if (!state.root || !findLeaf(state.root, paneId)) return state;
          const key = scopedThreadKey(threadRef);
          const root = findLeafByThreadKey(state.root, key)
            ? moveTabToPane(state.root, key, paneId, undefined, state.history)
            : insertTab(state.root, paneId, threadRef);
          return { root, focusedPaneId: paneId, history: visit(state.history, key) };
        }),
      closeTabs: (threadKeys, keepKey) => {
        const state = get();
        if (!state.root) return null;
        let root: ChatPaneNode = state.root;
        let history = state.history;
        for (const key of threadKeys) {
          root = closeTab(root, key, history);
          history = history.filter((entry) => entry !== key);
        }
        if (root === state.root) return null;
        const keepLeaf = keepKey ? findLeafByThreadKey(root, keepKey) : null;
        if (keepLeaf && keepKey) root = activateTab(root, keepLeaf.id, keepKey);
        const previousFocus = state.focusedPaneId;
        let focusedId: ChatPaneId | null = previousFocus;
        if (!focusedId || !findLeaf(root, focusedId)) {
          const sibling = previousFocus ? findSiblingLeaf(state.root, previousFocus) : null;
          focusedId =
            sibling && findLeaf(root, sibling.id) ? sibling.id : collectLeaves(root)[0]!.id;
        }
        const before = previousFocus ? findLeaf(state.root, previousFocus) : null;
        const after = findLeaf(root, focusedId)!;
        set({ root, focusedPaneId: focusedId, history });
        const next = leafActiveThread(after);
        const routeUnchanged =
          focusedId === previousFocus &&
          (before ? sameThread(leafActiveThread(before), next) : true);
        return routeUnchanged ? null : next;
      },
      dropTab: (threadKey, targetId, placement) => {
        const state = get();
        if (!state.root) return null;
        const root =
          "edge" in placement
            ? moveTabToEdge(
                state.root,
                threadKey,
                targetId,
                placement.edge,
                state.history,
                randomUUID(),
                randomUUID(),
              )
            : moveTabToPane(state.root, threadKey, targetId, placement.index, state.history);
        const leaf = findLeafByThreadKey(root, threadKey);
        if (!leaf) return null;
        if (root === state.root) return null;
        set({
          root: activateTab(root, leaf.id, threadKey),
          focusedPaneId: leaf.id,
          history: visit(state.history, threadKey),
        });
        return leaf.tabs.find((tab) => scopedThreadKey(tab) === threadKey) ?? null;
      },
      touch: (threadKey) =>
        set((state) => {
          const history = touchHistory(state.history, threadKey);
          return history === state.history ? state : { history };
        }),
      closePane: (paneId) => {
        const state = get();
        if (!state.root) return null;
        const closing = findLeaf(state.root, paneId);
        if (!closing) return null;
        const closingKeys = new Set(closing.tabs.map((tab) => scopedThreadKey(tab)));
        const history = state.history.filter((key) => !closingKeys.has(key));
        if (state.root.kind === "leaf") {
          set({ root: createLeaf(closing.id), focusedPaneId: closing.id, history });
          return null;
        }
        const sibling = findSiblingLeaf(state.root, paneId);
        const remaining = removePane(state.root, paneId);
        if (!remaining) return null;
        const wasFocused = state.focusedPaneId === paneId;
        const nextFocusId = wasFocused
          ? (sibling?.id ?? collectLeaves(remaining)[0]!.id)
          : state.focusedPaneId;
        const nextFocus = nextFocusId ? findLeaf(remaining, nextFocusId) : null;
        set({ root: remaining, focusedPaneId: nextFocus?.id ?? null, history });
        return wasFocused && nextFocus ? leafActiveThread(nextFocus) : null;
      },
      setRatio: (splitId, ratio) =>
        set((state) => {
          if (!state.root) return state;
          const root = setPaneRatio(state.root, splitId, clampPaneRatio(ratio));
          return root === state.root ? state : { root };
        }),
      reset: () => set({ root: null, focusedPaneId: null, history: [] }),
    }),
    {
      name: "t3code:fork-chat-panes:v1",
      version: STORAGE_VERSION,
      migrate: migratePersisted,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        root: state.root,
        focusedPaneId: state.focusedPaneId,
        history: state.history,
      }),
      merge: (persisted, current) => {
        try {
          const { root, focusedPaneId, history } = decodePersisted(persisted);
          const focused =
            root && focusedPaneId && findLeaf(root, focusedPaneId)
              ? focusedPaneId
              : root
                ? collectLeaves(root)[0]!.id
                : null;
          return { ...current, root, focusedPaneId: focused, history };
        } catch {
          return current;
        }
      },
    },
  ),
);

/** The focused pane's active thread, which the route should show. */
export function selectFocusedPaneThread(state: Pick<ChatPanesState, "root" | "focusedPaneId">) {
  if (!state.root || !state.focusedPaneId) return null;
  const leaf = findLeaf(state.root, state.focusedPaneId);
  return leaf ? leafActiveThread(leaf) : null;
}

export { sameThread as sameChatPaneThread };

/**
 * Opens `threadRef` (or an empty pane when null) beside the focused pane, or
 * beside `anchorThreadRef` when there is no layout yet. Returns false when the
 * thread is the only tab of the focused pane, which has nothing to split off.
 */
export function openChatPaneSplit(
  anchorThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef | null,
  edge: PaneEdge = "right",
): boolean {
  const state = useChatPanesStore.getState();
  if (threadRef) {
    const key = scopedThreadKey(threadRef);
    const source = state.root ? findLeafByThreadKey(state.root, key) : null;
    if (source ? source.tabs.length === 1 && source.id === state.focusedPaneId : false) {
      return false;
    }
    if (!state.root && anchorThreadRef && sameThread(threadRef, anchorThreadRef)) return false;
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
