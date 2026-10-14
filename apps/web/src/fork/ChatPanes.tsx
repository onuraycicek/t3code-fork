import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, PanelBottomIcon, PanelRightIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  collectLeaves,
  dropPreviewRect,
  resolvePaneDropZone,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type PaneDropZone,
} from "./chatPanes.logic";
import { useChatPanesStore } from "./chatPanesStore";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { cn, isMacPlatform } from "../lib/utils";
import { useProject, useThreadShell, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import ChatView from "../components/ChatView";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { ChatPaneProvider } from "./chatPaneContext";
import "./fork.css";

/** Height of each pane's strip; kept out of the top/bottom drop bands. */
const PANE_STRIP_HEIGHT = 30;
/** Pointer travel before a grip press becomes a pane drag. */
const DRAG_THRESHOLD_PX = 5;

interface PaneDragState {
  sourceId: ChatPaneId;
  target: { paneId: ChatPaneId; zone: PaneDropZone } | null;
  overlay: { left: number; top: number; width: number; height: number } | null;
}

/**
 * Orca-style split layout for chats: a recursive tree of flex splits, a
 * strip on each pane (grip, title, split and close), resize handles that
 * clamp to 15–85%, and pane drags that split on a target's outer 20% or swap
 * contents on its center. The focused pane owns input and mirrors the route.
 */
export function ChatPanes({ root }: { root: ChatPaneNode }) {
  const navigate = useNavigate();
  const focusedPaneId = useChatPanesStore((state) => state.focusedPaneId);
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const leaves = useMemo(() => collectLeaves(root), [root]);

  const openThread = useCallback(
    (threadRef: ScopedThreadRef | null) => {
      if (!threadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const focusPane = useCallback(
    (leaf: ChatPaneLeaf) => {
      const store = useChatPanesStore.getState();
      if (store.focusedPaneId === leaf.id) return;
      store.focusPane(leaf.id);
      openThread(leaf.threadRef);
    },
    [openThread],
  );

  const closePane = useCallback(
    (paneId: ChatPaneId) => {
      const survivor = useChatPanesStore.getState().closePane(paneId);
      if (survivor) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(survivor),
          replace: true,
        });
      }
    },
    [navigate],
  );

  const splitPane = useCallback((paneId: ChatPaneId, edge: "right" | "bottom") => {
    useChatPanesStore
      .getState()
      .split({ targetId: paneId, anchorThreadRef: null, edge, threadRef: null });
  }, []);

  // Pane shortcuts. Mod+\ splits right, Mod+Shift+\ splits down, Mod+Alt+W
  // closes the focused pane, Mod+Alt+Arrow moves focus through the panes.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
      const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      const store = useChatPanesStore.getState();
      const focusedId = store.focusedPaneId ?? leaves[0]?.id ?? null;
      if (!focusedId) return;
      if (event.code === "Backslash" && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        splitPane(focusedId, event.shiftKey ? "bottom" : "right");
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
  }, [closePane, focusPane, leaves, splitPane]);

  const startPaneDrag = useCallback(
    (paneId: ChatPaneId, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let current: PaneDragState | null = null;

      const update = (clientX: number, clientY: number) => {
        const element = document
          .elementsFromPoint(clientX, clientY)
          .find((node) => node instanceof HTMLElement && node.dataset.chatPaneId !== undefined) as
          | HTMLElement
          | undefined;
        const targetId = element?.dataset.chatPaneId ?? null;
        let next: PaneDragState = { sourceId: paneId, target: null, overlay: null };
        if (element && targetId && targetId !== paneId) {
          const rect = element.getBoundingClientRect();
          const zone = resolvePaneDropZone(rect, clientX, clientY, PANE_STRIP_HEIGHT);
          if (zone) {
            next = {
              sourceId: paneId,
              target: { paneId: targetId, zone },
              overlay: dropPreviewRect(rect, zone),
            };
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
        const store = useChatPanesStore.getState();
        store.dropPane(paneId, target.paneId, target.zone);
        const after = useChatPanesStore.getState();
        const moved = after.root
          ? collectLeaves(after.root).find((leaf) => leaf.id === paneId)
          : null;
        openThread(moved?.threadRef ?? null);
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
    },
    [openThread],
  );

  const context: PaneTreeContext = {
    focusedPaneId,
    dragSourceId: drag?.sourceId ?? null,
    paneCount: leaves.length,
    focusPane,
    closePane,
    splitPane,
    startPaneDrag,
    openThreadInPane: (paneId, threadRef) => {
      useChatPanesStore.getState().setPaneThread(paneId, threadRef);
      openThread(threadRef);
    },
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-chat-panes>
      <PaneNode node={root} path="" context={context} edges={ROOT_EDGES} />
      {drag?.overlay
        ? createPortal(
            <div
              data-chat-pane-drop-overlay=""
              className="pointer-events-none fixed z-[10001]"
              style={{
                left: drag.overlay.left,
                top: drag.overlay.top,
                width: drag.overlay.width,
                height: drag.overlay.height,
              }}
            >
              <span data-chat-pane-drop-label="">
                {drag.target?.zone === "center" ? "Swap panes" : "New split"}
              </span>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface PaneTreeContext {
  focusedPaneId: ChatPaneId | null;
  dragSourceId: ChatPaneId | null;
  paneCount: number;
  focusPane: (leaf: ChatPaneLeaf) => void;
  closePane: (paneId: ChatPaneId) => void;
  splitPane: (paneId: ChatPaneId, edge: "right" | "bottom") => void;
  startPaneDrag: (paneId: ChatPaneId, event: ReactPointerEvent<HTMLElement>) => void;
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
  const thread = useThreadShell(leaf.threadRef);
  const threadUsable = thread !== null && thread.deletedAt == null && thread.archivedAt == null;

  return (
    <section
      data-chat-pane-id={leaf.id}
      data-chat-pane-focused={focused ? "true" : "false"}
      aria-label={thread?.title ?? "Empty pane"}
      className={cn(
        "group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        context.dragSourceId === leaf.id && "opacity-40",
      )}
      // Pointer only: a remounted view can move DOM focus on its own, and
      // that must not steal pane focus. Keyboard users switch with Mod+Alt+Arrow.
      onPointerDownCapture={() => context.focusPane(leaf)}
    >
      <PaneStrip leaf={leaf} focused={focused} context={context} title={thread?.title ?? null} />
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
        {leaf.threadRef && threadUsable ? (
          <ChatPaneProvider value={{ focused, threadRef: leaf.threadRef }}>
            <ChatView
              environmentId={leaf.threadRef.environmentId}
              threadId={leaf.threadRef.threadId}
              routeKind="server"
              reserveTitleBarControlInset={edges.top && edges.left}
            />
          </ChatPaneProvider>
        ) : (
          <EmptyPanePicker
            paneId={leaf.id}
            missing={leaf.threadRef !== null}
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
  title,
}: {
  leaf: ChatPaneLeaf;
  focused: boolean;
  context: PaneTreeContext;
  title: string | null;
}) {
  const thread = useThreadShell(leaf.threadRef);
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center gap-1 border-b border-border bg-card px-1 [-webkit-app-region:no-drag]",
        focused ? "text-foreground" : "text-muted-foreground",
      )}
      style={{ height: PANE_STRIP_HEIGHT }}
    >
      <PaneTooltip label="Drag to move pane">
        <button
          type="button"
          aria-label="Drag to move pane"
          className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground active:cursor-grabbing"
          onPointerDown={(event) => context.startPaneDrag(leaf.id, event)}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      </PaneTooltip>
      {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {title ?? (leaf.threadRef ? "Unavailable thread" : "Empty pane")}
      </span>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity duration-150",
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
      </div>
      {focused && context.paneCount > 1 ? (
        <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-primary" />
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
  const recent = useMemo(() => {
    const open = new Set(
      (root ? collectLeaves(root) : [])
        .map((leaf) => leaf.threadRef)
        .filter((ref): ref is ScopedThreadRef => ref !== null)
        .map((ref) => scopedThreadKey(ref)),
    );
    return threads
      .filter(
        (thread) =>
          thread.deletedAt == null &&
          thread.archivedAt == null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          !open.has(scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id })),
      )
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, EMPTY_PANE_RECENT_LIMIT);
  }, [root, threads]);

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
