import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isMacPlatform } from "../lib/utils";
import type { ThreadRouteTarget } from "../threadRoutes";
import { useComposerDraftStore } from "../composerDraftStore";
import { createLeaf, type ChatPaneNode } from "./chatPanes.logic";
import { SEED_PANE_ID, openChatPaneSplit, useChatPanesStore } from "./chatPanesStore";

/**
 * Connects the thread route to the tabbed pane layout. Returns the layout root,
 * or null for the plain upstream view (loading or missing thread, or a draft
 * route whose session is gone).
 *
 * - Any ready server thread route puts the window into the pane layout, even
 *   with a single pane. The first frame uses a seed pane identical to the one
 *   the sync effect stores, so the chat view does not remount.
 * - A draft route is a tab like any thread: it holds the thread ref the draft
 *   session reserved, so it opens as a new tab of the focused pane and turns
 *   into the server thread's tab in place when the draft is promoted.
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
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftEnvironmentId = draftSession?.environmentId ?? null;
  const draftThreadId = draftSession?.threadId ?? null;
  // The thread the route is about: the server thread, or the draft's reserved one.
  const serverEnvironmentId = target.kind === "server" ? target.threadRef.environmentId : null;
  const serverThreadId = target.kind === "server" ? target.threadRef.threadId : null;
  const routeEnvironmentId = serverEnvironmentId ?? draftEnvironmentId;
  const routeThreadId = serverThreadId ?? draftThreadId;
  const routeRef =
    routeEnvironmentId !== null && routeThreadId !== null
      ? { environmentId: routeEnvironmentId, threadId: routeThreadId }
      : null;
  const routeThreadKey = routeRef ? scopedThreadKey(routeRef) : null;
  const latestTargetRef = useRef(target);
  const latestRouteRef = useRef(routeRef);
  useEffect(() => {
    latestTargetRef.current = target;
    latestRouteRef.current = routeRef;
  });

  useEffect(() => {
    const latest = latestTargetRef.current;
    const ref = latestRouteRef.current;
    // A draft route has no server thread to wait for: its session is the proof.
    if (!ref || (latest.kind === "server" && renderState === "missing")) return;
    useChatPanesStore.getState().syncRouteThread(ref, { draft: latest.kind === "draft" });
  }, [
    renderState,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only a route change syncs; the latest route is read from the ref.
    routeThreadKey,
  ]);

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

  if (routeRef === null) return null;
  const seedRoot = createLeaf(SEED_PANE_ID, [routeRef]);
  return paneRoot ?? (target.kind === "draft" || renderState === "ready" ? seedRoot : null);
}
