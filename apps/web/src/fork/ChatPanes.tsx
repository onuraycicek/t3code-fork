import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PanelBottomIcon, PanelRightIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import {
  collectLeaves,
  dropPreviewRect,
  resolveDraftTabCleanup,
  findLeaf,
  findLeafByThreadKey,
  leafActiveThread,
  resolvePaneDropZone,
  resolveTabDropIndex,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type PaneEdge,
} from "./chatPanes.logic";
import { useChatPanesStore } from "./chatPanesStore";
import { SidebarVisibleThreads } from "./SidebarVisibleThreads";
import { MoveTerminalDialog } from "./MoveTerminalDialog";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { cn, isMacPlatform } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProject, useThreadRefs, useThreadShell, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import ChatView from "../components/ChatView";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { ChatPaneProvider, PaneComposerScope } from "./chatPaneContext";
import {
  draftRouteIdForTab,
  useDraftIdByRef,
  useDraftSessionByRef,
  useLatchedViewKey,
} from "./draftTabs";
import "./fork.css";

/** Height of each pane's tab strip; kept out of the top/bottom drop bands. */
const PANE_STRIP_HEIGHT = 30;
/** Pointer travel before a tab press becomes a tab drag. */
const DRAG_THRESHOLD_PX = 5;

interface TabDragState {
  sourceKey: string;
  target: {
    paneId: ChatPaneId;
    placement: { edge: PaneEdge } | { index: number } | { body: true };
  } | null;
  overlay: {
    rect: { left: number; top: number; width: number; height: number };
    kind: "insert" | "zone";
    label: string | null;
  } | null;
}

type TabMenuAction = "close" | "close-others" | "close-right" | "close-all";

/**
 * Orca-style tabbed split layout. Only each pane's active tab mounts a chat; the
 * focused pane owns input and mirrors the route.
 */
export function ChatPanes({ root }: { root: ChatPaneNode }) {
  const navigate = useNavigate();
  const focusedPaneId = useChatPanesStore((state) => state.focusedPaneId);
  const [drag, setDrag] = useState<TabDragState | null>(null);
  const leaves = collectLeaves(root);
  const draftTabKeys = useChatPanesStore((state) => state.draftTabKeys);
  const draftThreadKeys = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const serverThreadRefs = useThreadRefs();

  const openThread = (threadRef: ScopedThreadRef | null, replace = false) => {
    if (!threadRef) return;
    // A tab that is still a draft lives on the draft route.
    const draftId = draftRouteIdForTab(threadRef);
    if (draftId) {
      void navigate({ to: "/draft/$draftId", params: { draftId }, replace });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace,
    });
  };

  const focusPane = (leaf: ChatPaneLeaf) => {
    const store = useChatPanesStore.getState();
    if (store.focusedPaneId === leaf.id) return;
    store.focusPane(leaf.id);
    openThread(leafActiveThread(leaf));
  };

  // After a close the route follows the surviving tab. With nothing left open,
  // leave the closed thread's route (go home) so opening it again from the
  // sidebar is a real route change that adds a fresh tab.
  const followClose = (survivor: ScopedThreadRef | null) => {
    if (survivor) {
      openThread(survivor, true);
      return;
    }
    const state = useChatPanesStore.getState();
    const focused =
      state.root && state.focusedPaneId ? findLeaf(state.root, state.focusedPaneId) : null;
    if (!focused || leafActiveThread(focused) === null) {
      void navigate({ to: "/", replace: true });
    }
  };

  const closePane = (paneId: ChatPaneId) => {
    followClose(useChatPanesStore.getState().closePane(paneId));
  };

  const closeTabs = (threadKeys: readonly string[], keepKey?: string) => {
    followClose(useChatPanesStore.getState().closeTabs(threadKeys, keepKey));
  };

  const activateTab = (paneId: ChatPaneId, threadKey: string) => {
    const store = useChatPanesStore.getState();
    store.activateTab(paneId, threadKey);
    const leaf = useChatPanesStore.getState().root
      ? findLeafByThreadKey(useChatPanesStore.getState().root!, threadKey)
      : null;
    openThread(leaf ? leafActiveThread(leaf) : null);
  };

  // Draft tabs follow their draft: promoted ones stop being tracked, ones whose
  // draft was discarded (e.g. after a reload) close instead of staying broken.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconciles the pane store with draft promotions and discards made elsewhere.
  useEffect(() => {
    if (draftTabKeys.length === 0) return;
    const { untrack, close } = resolveDraftTabCleanup({
      draftTabKeys,
      openKeys: new Set(leaves.flatMap((leaf) => leaf.tabs.map((tab) => scopedThreadKey(tab)))),
      draftSessionKeys: new Set(
        Object.values(draftThreadKeys).map((session) =>
          // Explicit ref: a session also carries projectId, which scopedThreadKey would pick.
          scopedThreadKey({ environmentId: session.environmentId, threadId: session.threadId }),
        ),
      ),
      serverKeys: new Set(serverThreadRefs.map((ref) => scopedThreadKey(ref))),
    });
    // No route follow-up here: a closed draft's own route already redirects, and
    // the route may meanwhile name another thread whose tab is about to sync in.
    if (close.length > 0) useChatPanesStore.getState().closeTabs(close);
    if (untrack.length > 0) useChatPanesStore.getState().untrackDraftTabs(untrack);
  }, [draftTabKeys, draftThreadKeys, leaves, serverThreadRefs]);

  const splitPane = (paneId: ChatPaneId, edge: "right" | "bottom") => {
    useChatPanesStore
      .getState()
      .split({ targetId: paneId, anchorThreadRef: null, edge, threadRef: null });
  };

  const showTabMenu = async (
    leaf: ChatPaneLeaf,
    threadKey: string,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const index = leaf.tabs.findIndex((tab) => scopedThreadKey(tab) === threadKey);
    if (index < 0) return;
    const clicked = (await api.contextMenu.show(
      [
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: leaf.tabs.length < 2 },
        {
          id: "close-right",
          label: "Close tabs to the right",
          disabled: index >= leaf.tabs.length - 1,
        },
        { id: "close-all", label: "Close all", separatorBefore: true },
      ] satisfies {
        id: TabMenuAction;
        label: string;
        disabled?: boolean;
        separatorBefore?: boolean;
      }[],
      position,
    )) as TabMenuAction | null;
    if (!clicked) return;
    const keyOf = (tab: ScopedThreadRef) => scopedThreadKey(tab);
    switch (clicked) {
      case "close":
        closeTabs([threadKey]);
        return;
      case "close-others":
        closeTabs(
          leaf.tabs.map(keyOf).filter((key) => key !== threadKey),
          threadKey,
        );
        return;
      case "close-right":
        closeTabs(leaf.tabs.slice(index + 1).map(keyOf), threadKey);
        return;
      case "close-all":
        closeTabs(leaf.tabs.map(keyOf));
        return;
    }
  };

  // Pane and tab shortcuts (see FORK.md). Tab jumps use Alt+1..9 off macOS,
  // where Ctrl+digit is taken; Ctrl+Tab never leaves the focused pane.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Window keydown listener for pane and tab shortcuts.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
      const isMac = isMacPlatform(navigator.platform);
      const store = useChatPanesStore.getState();
      const focusedLeaf =
        (store.focusedPaneId && leaves.find((leaf) => leaf.id === store.focusedPaneId)) ||
        leaves[0] ||
        null;
      if (!focusedLeaf) return;

      if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        const keys = focusedLeaf.tabs.map((tab) => scopedThreadKey(tab));
        if (keys.length < 2) return;
        const current = focusedLeaf.activeKey ? keys.indexOf(focusedLeaf.activeKey) : -1;
        const step = event.shiftKey ? -1 : 1;
        const next = keys[(Math.max(current, 0) + step + keys.length) % keys.length]!;
        activateTab(focusedLeaf.id, next);
        return;
      }

      const digitModifier = isMac
        ? event.ctrlKey && !event.metaKey && !event.altKey
        : event.altKey && !event.ctrlKey && !event.metaKey;
      if (digitModifier && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        const tab = focusedLeaf.tabs[Number(event.code.slice(5)) - 1];
        if (!tab) return;
        event.preventDefault();
        event.stopPropagation();
        activateTab(focusedLeaf.id, scopedThreadKey(tab));
        return;
      }

      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      const focusedId = focusedLeaf.id;
      if (event.code === "Backslash" && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        splitPane(focusedId, event.shiftKey ? "bottom" : "right");
        return;
      }
      if (event.shiftKey && !event.altKey && event.code === "KeyW") {
        if (!focusedLeaf.activeKey) return;
        event.preventDefault();
        event.stopPropagation();
        closeTabs([focusedLeaf.activeKey]);
        return;
      }
      if (event.altKey && !event.shiftKey && event.code === "KeyW") {
        event.preventDefault();
        event.stopPropagation();
        closePane(focusedId);
        return;
      }
      if (event.altKey && !event.shiftKey && event.key.startsWith("Arrow")) {
        const index = leaves.findIndex((leaf) => leaf.id === focusedId);
        if (index < 0) return;
        const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = leaves[(index + step + leaves.length) % leaves.length];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        focusPane(next);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activateTab, closePane, closeTabs, focusPane, leaves, splitPane]);

  const startTabDrag = (
    threadKey: string,
    sourcePaneId: ChatPaneId,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let current: TabDragState | null = null;

    const update = (clientX: number, clientY: number) => {
      const element = document
        .elementsFromPoint(clientX, clientY)
        .find((node) => node instanceof HTMLElement && node.dataset.chatPaneId !== undefined) as
        | HTMLElement
        | undefined;
      const targetId = element?.dataset.chatPaneId ?? null;
      let next: TabDragState = { sourceKey: threadKey, target: null, overlay: null };
      if (element && targetId) {
        const rect = element.getBoundingClientRect();
        const storeRoot = useChatPanesStore.getState().root;
        const sourceLeaf = storeRoot ? findLeafByThreadKey(storeRoot, threadKey) : null;
        const sameAsSource = targetId === sourcePaneId;
        if (clientY - rect.top < PANE_STRIP_HEIGHT && clientY >= rect.top) {
          // Over the strip: insert between tabs.
          const tabEls = Array.from(element.querySelectorAll<HTMLElement>("[data-chat-tab-key]"));
          const rects = tabEls.map((el) => el.getBoundingClientRect());
          const index = resolveTabDropIndex(
            rects.map((tabRect) => tabRect.left + tabRect.width / 2),
            clientX,
          );
          const lineX =
            index < rects.length
              ? rects[index]!.left
              : rects.length > 0
                ? rects[rects.length - 1]!.right
                : rect.left + 4;
          next = {
            sourceKey: threadKey,
            target: { paneId: targetId, placement: { index } },
            overlay: {
              rect: {
                left: lineX - 1,
                top: rect.top + 3,
                width: 2,
                height: PANE_STRIP_HEIGHT - 6,
              },
              kind: "insert",
              label: null,
            },
          };
        } else {
          const zone = resolvePaneDropZone(rect, clientX, clientY, PANE_STRIP_HEIGHT);
          if (zone === "center") {
            if (!sameAsSource) {
              next = {
                sourceKey: threadKey,
                target: { paneId: targetId, placement: { body: true } },
                overlay: {
                  rect: dropPreviewRect(rect, zone),
                  kind: "zone",
                  label: "Move tab here",
                },
              };
            }
          } else if (zone && !(sameAsSource && sourceLeaf?.tabs.length === 1)) {
            next = {
              sourceKey: threadKey,
              target: { paneId: targetId, placement: { edge: zone } },
              overlay: { rect: dropPreviewRect(rect, zone), kind: "zone", label: "New split" },
            };
          }
        }
      }
      current = next;
      setDrag(next);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!active) {
        if (
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        active = true;
        document.body.classList.add("chat-pane-dragging");
      }
      update(moveEvent.clientX, moveEvent.clientY);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("chat-pane-dragging");
      const target = current?.target ?? null;
      current = null;
      setDrag(null);
      if (!commit || !active || !target) return;
      const placement =
        "body" in target.placement
          ? {}
          : "edge" in target.placement
            ? { edge: target.placement.edge }
            : { index: target.placement.index };
      openThread(useChatPanesStore.getState().dropTab(threadKey, target.paneId, placement));
    };
    const onUp = () => finish(true);
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
  };

  const context: PaneTreeContext = {
    focusedPaneId,
    dragSourceKey: drag?.sourceKey ?? null,
    paneCount: leaves.length,
    focusPane,
    closePane,
    closeTabs,
    activateTab,
    splitPane,
    startTabDrag,
    showTabMenu,
    openThreadInPane: (paneId, threadRef) => {
      useChatPanesStore.getState().setPaneThread(paneId, threadRef);
      openThread(threadRef);
    },
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-chat-panes>
      <SidebarVisibleThreads root={root} focusedPaneId={focusedPaneId} />
      <MoveTerminalDialog />
      <PaneNode node={root} path="" context={context} edges={ROOT_EDGES} />
      {drag?.overlay
        ? createPortal(
            <div
              data-chat-pane-drop-overlay={drag.overlay.kind}
              className="pointer-events-none fixed z-[10001]"
              style={{
                left: drag.overlay.rect.left,
                top: drag.overlay.rect.top,
                width: drag.overlay.rect.width,
                height: drag.overlay.rect.height,
              }}
            >
              {drag.overlay.label ? (
                <span data-chat-pane-drop-label="">{drag.overlay.label}</span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface PaneTreeContext {
  focusedPaneId: ChatPaneId | null;
  dragSourceKey: string | null;
  paneCount: number;
  focusPane: (leaf: ChatPaneLeaf) => void;
  closePane: (paneId: ChatPaneId) => void;
  closeTabs: (threadKeys: readonly string[], keepKey?: string) => void;
  activateTab: (paneId: ChatPaneId, threadKey: string) => void;
  splitPane: (paneId: ChatPaneId, edge: "right" | "bottom") => void;
  startTabDrag: (
    threadKey: string,
    paneId: ChatPaneId,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  showTabMenu: (
    leaf: ChatPaneLeaf,
    threadKey: string,
    position: { x: number; y: number },
  ) => Promise<void>;
  openThreadInPane: (paneId: ChatPaneId, threadRef: ScopedThreadRef) => void;
}

/** Which outer edges of the window a node touches; the top-left pane keeps the titlebar inset. */
interface PaneEdges {
  top: boolean;
  left: boolean;
}
const ROOT_EDGES: PaneEdges = { top: true, left: true };

function PaneNode({
  node,
  path,
  context,
  edges,
}: {
  node: ChatPaneNode;
  path: string;
  context: PaneTreeContext;
  edges: PaneEdges;
}) {
  if (node.kind === "leaf") {
    return <PaneLeaf leaf={node} context={context} edges={edges} />;
  }
  return <PaneSplit node={node} path={path} context={context} edges={edges} />;
}

function PaneSplit({
  node,
  path,
  context,
  edges,
}: {
  node: Extract<ChatPaneNode, { kind: "split" }>;
  path: string;
  context: PaneTreeContext;
  edges: PaneEdges;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLDivElement | null>(null);
  const secondRef = useRef<HTMLDivElement | null>(null);
  const horizontal = node.direction === "horizontal";
  const firstEdges = edges;
  const secondEdges: PaneEdges = horizontal
    ? { top: edges.top, left: false }
    : { top: false, left: edges.left };

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{ flexDirection: horizontal ? "row" : "column" }}
    >
      <div
        ref={firstRef}
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${node.ratio} 1 0%` }}
      >
        <PaneNode node={node.first} path={`${path}first.`} context={context} edges={firstEdges} />
      </div>
      <PaneResizeHandle
        splitId={node.id}
        horizontal={horizontal}
        ratio={node.ratio}
        containerRef={containerRef}
        firstRef={firstRef}
        secondRef={secondRef}
      />
      <div
        ref={secondRef}
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${1 - node.ratio} 1 0%` }}
      >
        <PaneNode
          node={node.second}
          path={`${path}second.`}
          context={context}
          edges={secondEdges}
        />
      </div>
    </div>
  );
}

/**
 * Pointer-captured divider. While dragging it writes flex straight to the DOM
 * and only commits the ratio on release; double-click resets to 50/50.
 */
function PaneResizeHandle({
  splitId,
  horizontal,
  ratio,
  containerRef,
  firstRef,
  secondRef,
}: {
  splitId: ChatPaneId;
  horizontal: boolean;
  ratio: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  firstRef: React.RefObject<HTMLDivElement | null>;
  secondRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const pendingRatio = useRef<number | null>(null);

  const applyRatio = (next: number) => {
    if (firstRef.current) firstRef.current.style.flex = `${next} 1 0%`;
    if (secondRef.current) secondRef.current.style.flex = `${1 - next} 1 0%`;
  };

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(ratio * 100)}
      data-chat-pane-resize={horizontal ? "col" : "row"}
      data-dragging={dragging ? "" : undefined}
      className="shrink-0"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        document.body.classList.add("chat-pane-resizing");
      }}
      onPointerMove={(event) => {
        if (!dragging || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const raw = horizontal
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
        const next = Math.min(0.85, Math.max(0.15, raw));
        pendingRatio.current = next;
        applyRatio(next);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        document.body.classList.remove("chat-pane-resizing");
        const next = pendingRatio.current;
        pendingRatio.current = null;
        if (next !== null && next !== ratio) {
          useChatPanesStore.getState().setRatio(splitId, next);
        }
      }}
      onDoubleClick={() => {
        applyRatio(0.5);
        useChatPanesStore.getState().setRatio(splitId, 0.5);
      }}
    />
  );
}

const PaneLeaf = memo(function PaneLeaf({
  leaf,
  context,
  edges,
}: {
  leaf: ChatPaneLeaf;
  context: PaneTreeContext;
  edges: PaneEdges;
}) {
  const focused = context.focusedPaneId === leaf.id;
  const activeRef = leafActiveThread(leaf);
  const thread = useThreadShell(activeRef);
  const threadUsable = thread !== null && thread.deletedAt == null && thread.archivedAt == null;
  const draftId = useDraftIdByRef(activeRef);
  const routeParams = useParams({ strict: false }) as {
    environmentId?: string;
    threadId?: string;
  };
  const routeIsThisThread =
    activeRef !== null &&
    routeParams.environmentId === activeRef.environmentId &&
    routeParams.threadId === activeRef.threadId;
  // A draft keeps its draft view until the route moves to the promoted thread
  // (ThreadRouteView navigates once the server owns the first send); the view
  // key then carries one ChatView instance through that swap.
  const draftView = draftId !== null && !(threadUsable && routeIsThisThread);
  const viewKey = useLatchedViewKey(activeRef, draftId);

  return (
    <section
      data-chat-pane-id={leaf.id}
      data-chat-pane-focused={focused ? "true" : "false"}
      aria-label={thread?.title ?? (draftId ? "New thread" : "Empty pane")}
      className="group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      // Pointer only: a remounted view can move DOM focus on its own, and
      // that must not steal pane focus. Keyboard users switch with Mod+Alt+Arrow.
      onPointerDownCapture={() => context.focusPane(leaf)}
    >
      <PaneStrip leaf={leaf} focused={focused} context={context} />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          !focused && "opacity-95",
        )}
        // A transform makes the pane body the containing block for the chat's
        // fixed-position chrome, so each pane keeps its header controls to
        // itself, below the pane strip.
        style={{ transform: "translateZ(0)" }}
      >
        {activeRef && draftView && draftId ? (
          <ChatPaneProvider key={leaf.activeKey} value={{ focused, threadRef: activeRef }}>
            <PaneComposerScope focused={focused}>
              <ChatView
                key={viewKey}
                draftId={draftId}
                environmentId={activeRef.environmentId}
                threadId={activeRef.threadId}
                routeKind="draft"
                reserveTitleBarControlInset={edges.top && edges.left}
              />
            </PaneComposerScope>
          </ChatPaneProvider>
        ) : activeRef && threadUsable ? (
          // Only the active tab mounts a chat; keyed so switching tabs resets it.
          <ChatPaneProvider key={leaf.activeKey} value={{ focused, threadRef: activeRef }}>
            <PaneComposerScope focused={focused}>
              <ChatView
                key={viewKey}
                environmentId={activeRef.environmentId}
                threadId={activeRef.threadId}
                routeKind="server"
                reserveTitleBarControlInset={edges.top && edges.left}
              />
            </PaneComposerScope>
          </ChatPaneProvider>
        ) : (
          <EmptyPanePicker
            paneId={leaf.id}
            missing={activeRef !== null}
            onPick={context.openThreadInPane}
          />
        )}
      </div>
    </section>
  );
});

function PaneStrip({
  leaf,
  focused,
  context,
}: {
  leaf: ChatPaneLeaf;
  focused: boolean;
  context: PaneTreeContext;
}) {
  const tabsRef = useRef<HTMLDivElement | null>(null);
  // Keep the active tab in view when the strip overflows.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls the DOM tab strip to the active tab.
  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>("[data-chat-tab-active='true']");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new active tab or tab count scrolls the active tab back into view.
    leaf.activeKey,
    leaf.tabs.length,
  ]);

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-stretch border-b border-border bg-card [-webkit-app-region:no-drag]",
        focused ? "text-foreground" : "text-muted-foreground",
      )}
      style={{ height: PANE_STRIP_HEIGHT }}
    >
      <div
        ref={tabsRef}
        role="tablist"
        data-chat-pane-tabs=""
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        onWheel={(event) => {
          // A vertical wheel scrolls the strip sideways.
          if (event.deltaX === 0 && tabsRef.current) tabsRef.current.scrollLeft += event.deltaY;
        }}
      >
        {leaf.tabs.map((tab) => (
          <PaneTab
            key={scopedThreadKey(tab)}
            leaf={leaf}
            threadRef={tab}
            paneFocused={focused}
            context={context}
          />
        ))}
        {leaf.tabs.length === 0 ? (
          <span className="flex items-center px-3 text-xs font-medium">Empty pane</span>
        ) : null}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 px-1 transition-opacity duration-150",
          focused
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover/pane:opacity-100",
        )}
      >
        <PaneTooltip label="Split right (⌘\)">
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Split right"
            onClick={() => context.splitPane(leaf.id, "right")}
          >
            <PanelRightIcon />
          </Button>
        </PaneTooltip>
        <PaneTooltip label="Split down (⌘⇧\)">
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Split down"
            onClick={() => context.splitPane(leaf.id, "bottom")}
          >
            <PanelBottomIcon />
          </Button>
        </PaneTooltip>
        {context.paneCount > 1 ? (
          <PaneTooltip label="Close pane (⌘⌥W)">
            <Button
              variant="ghost-muted"
              size="icon-micro"
              aria-label="Close pane"
              onClick={() => context.closePane(leaf.id)}
            >
              <XIcon />
            </Button>
          </PaneTooltip>
        ) : null}
      </div>
    </div>
  );
}

function PaneTab({
  leaf,
  threadRef,
  paneFocused,
  context,
}: {
  leaf: ChatPaneLeaf;
  threadRef: ScopedThreadRef;
  paneFocused: boolean;
  context: PaneTreeContext;
}) {
  const key = scopedThreadKey(threadRef);
  const active = leaf.activeKey === key;
  const thread = useThreadShell(threadRef);
  const draftSession = useDraftSessionByRef(threadRef);
  const projectScope = thread ?? draftSession;
  const project = useProject(
    projectScope
      ? { environmentId: projectScope.environmentId, projectId: projectScope.projectId }
      : null,
  );
  const status = thread ? resolveThreadStatusPill({ thread }) : null;
  const title = thread?.title ?? (draftSession ? "New thread" : "Unavailable thread");
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={title}
      data-chat-tab-key={key}
      data-chat-tab-active={active ? "true" : "false"}
      className={cn(
        "group/tab relative flex min-w-[96px] max-w-[200px] shrink-0 cursor-default select-none items-center gap-1.5 border-r border-border pr-1 pl-2 text-xs",
        active ? "bg-background text-foreground" : "hover:bg-accent/50",
        context.dragSourceKey === key && "opacity-40",
      )}
      onPointerDown={(event) => {
        if (event.button === 1) {
          // Middle click closes; stop the browser's autoscroll.
          event.preventDefault();
          return;
        }
        if (event.button !== 0) return;
        context.activateTab(leaf.id, key);
        context.startTabDrag(key, leaf.id, event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        context.closeTabs([key]);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void context.showTabMenu(leaf, key, { x: event.clientX, y: event.clientY });
      }}
    >
      {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
      {status ? (
        <span
          aria-label={status.label}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status.dotClass,
            status.pulse && "animate-pulse",
          )}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <button
        type="button"
        aria-label="Close tab"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
          active
            ? "opacity-100"
            : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          context.closeTabs([key]);
        }}
      >
        <XIcon className="size-3" />
      </button>
      {active ? (
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 bottom-0 h-[2px]",
            paneFocused ? "bg-primary" : "bg-muted-foreground/50",
          )}
        />
      ) : null}
    </div>
  );
}

function PaneTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

const EMPTY_PANE_RECENT_LIMIT = 15;

/** An empty pane offers the most recently updated threads not already on screen. */
function EmptyPanePicker({
  paneId,
  missing,
  onPick,
}: {
  paneId: ChatPaneId;
  missing: boolean;
  onPick: (paneId: ChatPaneId, threadRef: ScopedThreadRef) => void;
}) {
  const threads = useThreadShells();
  const root = useChatPanesStore((state) => state.root);
  const open = new Set(
    (root ? collectLeaves(root) : []).flatMap((leaf) =>
      leaf.tabs.map((ref) => scopedThreadKey(ref)),
    ),
  );
  const recent = threads
    .filter(
      (thread) =>
        thread.deletedAt == null &&
        thread.archivedAt == null &&
        thread.lineage.relationshipToParent !== "subagent" &&
        !open.has(scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id })),
    )
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, EMPTY_PANE_RECENT_LIMIT);

  return (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-md">
        <p className="mb-1 text-sm font-medium text-foreground">
          {missing ? "This thread is no longer available" : "Open a thread in this pane"}
        </p>
        <p className="mb-4 text-xs text-muted-foreground">
          Pick a recent thread, or click any thread in the sidebar while this pane is focused.
        </p>
        <ul className="flex flex-col gap-0.5">
          {recent.map((thread) => (
            <EmptyPaneThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              thread={thread}
              onPick={() =>
                onPick(paneId, { environmentId: thread.environmentId, threadId: thread.id })
              }
            />
          ))}
          {recent.length === 0 ? (
            <li className="text-xs text-muted-foreground">No other threads yet.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function EmptyPaneThreadRow({
  thread,
  onPick,
}: {
  thread: ReturnType<typeof useThreadShells>[number];
  onPick: () => void;
}) {
  const project = useProject({ environmentId: thread.environmentId, projectId: thread.projectId });
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {project ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">{project.title}</span>
        ) : null}
      </button>
    </li>
  );
}
