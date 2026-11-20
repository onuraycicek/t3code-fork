import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { buildThreadRouteParams } from "../threadRoutes";
import { findLeaf, leafActiveThread } from "./chatPanes.logic";
import type { PaneLayout } from "./chatPanesStore";
import { draftRouteIdForTab } from "./draftTabs";
import { findWorkspaceForThread, revealWorkspaceTab, useWorkspacesStore } from "./workspacesStore";

/** The router's navigate, loosened so hooks and the router object can both pass it. */
export type RouteNavigate = (options: { to: string; params?: Record<string, string> }) => unknown;

/** Moves the route to `threadRef` (its draft route while it is still a draft). */
function navigateToThread(threadRef: ScopedThreadRef, navigate: RouteNavigate): void {
  const draftId = draftRouteIdForTab(threadRef);
  if (draftId) {
    navigate({ to: "/draft/$draftId", params: { draftId } });
    return;
  }
  navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef) as Record<string, string>,
  });
}

/** The route mirrors the focused tab, so it follows a freshly loaded workspace's one. */
export function navigateToLayout(layout: PaneLayout | null | false, navigate: RouteNavigate): void {
  if (!layout) return;
  const focused =
    layout.root && layout.focusedPaneId ? findLeaf(layout.root, layout.focusedPaneId) : null;
  const threadRef = focused ? leafActiveThread(focused) : null;
  if (threadRef) navigateToThread(threadRef, navigate);
  else navigate({ to: "/" });
}

/** Opens a tab listed under a workspace: switch there, bring the tab forward, follow it. */
export function openWorkspaceTab(
  workspaceId: string,
  threadRef: ScopedThreadRef,
  navigate: RouteNavigate,
): void {
  if (revealWorkspaceTab(workspaceId, threadRef)) navigateToThread(threadRef, navigate);
}

/**
 * Notification click: open the thread in the workspace that has its tab, so it does
 * not land as a new tab in whatever workspace is selected.
 */
export function openNotifiedThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  navigate: RouteNavigate,
): void {
  const threadRef = { environmentId, threadId };
  const workspaceId = findWorkspaceForThread(threadRef);
  if (workspaceId) revealWorkspaceTab(workspaceId, threadRef);
  navigateToThread(threadRef, navigate);
}

/** Notification text: "Workspace · Thread" when a workspace has the thread's tab. */
export function workspaceNotificationLabel(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: string,
): string {
  const workspaceId = findWorkspaceForThread({ environmentId, threadId });
  const name = useWorkspacesStore
    .getState()
    .workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  return name ? `${name} · ${title}` : title;
}
