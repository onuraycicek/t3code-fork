import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isMacPlatform } from "../lib/utils";
import type { ThreadRouteTarget } from "../threadRoutes";
import { createLeaf, type ChatPaneNode } from "./chatPanes.logic";
import { SEED_PANE_ID, openChatPaneSplit, useChatPanesStore } from "./chatPanesStore";

/**
 * Connects the thread route to the tabbed pane layout. Returns the layout root,
 * or null for the plain upstream view (no server thread open: draft route,
 * loading or missing thread).
 *
 * - Any ready server thread route puts the window into the pane layout, even
 *   with a single pane. The first frame uses a seed pane identical to the one
 *   the sync effect stores, so the chat view does not remount.
 * - A draft that is promoted to a server thread becomes a route change, so it
 *   lands as a new tab of the focused pane.
 * - The route names the focused pane, so a route change is mirrored into the
 *   layout. Only route changes sync: a layout edit such as a closed pane must
 *   not pull the stale route thread back before the follow-up navigation lands,
 *   and a layout that just appeared already placed and focused its panes.
 * - Mod+\ (right) and Mod+Shift+\ (down) start a split from the plain view;
 *   once a layout exists, ChatPanes owns the pane shortcuts.
 */
export function useChatPaneRoute(
  target: ThreadRouteTarget,
  renderState: string,
): ChatPaneNode | null {
  const paneRoot = useChatPanesStore((state) => state.root);
  const hasPaneLayout = paneRoot !== null;
  const routeThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const latestTargetRef = useRef(target);
  useEffect(() => {
    latestTargetRef.current = target;
  });

  useEffect(() => {
    const latest = latestTargetRef.current;
    if (latest.kind !== "server" || renderState === "missing") return;
    useChatPanesStore.getState().syncRouteThread(latest.threadRef);
  }, [renderState, routeThreadKey]);

  useEffect(() => {
    if (hasPaneLayout || target.kind !== "server" || renderState !== "ready") return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      if (event.code !== "Backslash" || isCommandPaletteOpen()) return;
      const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      event.preventDefault();
      event.stopPropagation();
      const latest = latestTargetRef.current;
      if (latest.kind !== "server") return;
      openChatPaneSplit(latest.threadRef, null, event.shiftKey ? "bottom" : "right");
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [hasPaneLayout, renderState, target.kind]);

  const routeEnvironmentId = target.kind === "server" ? target.threadRef.environmentId : null;
  const routeThreadId = target.kind === "server" ? target.threadRef.threadId : null;
  const seedRoot = useMemo(
    () =>
      routeEnvironmentId !== null && routeThreadId !== null
        ? createLeaf(SEED_PANE_ID, [{ environmentId: routeEnvironmentId, threadId: routeThreadId }])
        : null,
    [routeEnvironmentId, routeThreadId],
  );
  if (target.kind !== "server") return null;
  return paneRoot ?? (renderState === "ready" ? seedRoot : null);
}
