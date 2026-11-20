/* oxlint-disable t3code/no-untranslated-copy -- fork UI is English-only; translating it would touch upstream locale catalogs every sync */
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { findLeaf, leafActiveThread } from "./chatPanes.logic";
import type { PaneLayout } from "./chatPanesStore";
import { draftRouteIdForTab } from "./draftTabs";
import {
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  switchWorkspace,
  useWorkspacesStore,
} from "./workspacesStore";

const EXPANDED_KEY = "t3code:fork-workspaces-expanded";

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Fork: the workspace list at the top of the sidebar. A workspace is a saved tab/split
 * layout; whatever is opened or arranged goes into the selected one.
 */
export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeId = useWorkspacesStore((state) => state.activeId);
  const busyIds = useWorkspacesStore((state) => state.busyIds);
  const [expanded, setExpanded] = useState(readExpanded);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // The route mirrors the focused tab, so it moves to the loaded workspace's one.
  const followLayout = (layout: PaneLayout | null | false) => {
    if (!layout) return;
    const focused =
      layout.root && layout.focusedPaneId ? findLeaf(layout.root, layout.focusedPaneId) : null;
    const threadRef = focused ? leafActiveThread(focused) : null;
    if (!threadRef) {
      void navigate({ to: "/" });
      return;
    }
    const draftId = draftRouteIdForTab(threadRef);
    if (draftId) {
      void navigate({ to: "/draft/$draftId", params: { draftId } });
      return;
    }
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, String(next));
    } catch {}
  };

  const addWorkspace = () => {
    followLayout(createWorkspace());
    setRenamingId(useWorkspacesStore.getState().activeId);
    if (!expanded) toggle();
  };

  return (
    <div className="px-2 pb-1">
      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader expanded={expanded} onClick={toggle}>
            Workspaces
          </CollapsibleSectionHeader>
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          aria-label="New workspace"
          onClick={addWorkspace}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-px" aria-label="Workspaces">
          {workspaces.map((workspace) => {
            const active = workspace.id === activeId;
            const busy = busyIds.includes(workspace.id);
            if (renamingId === workspace.id) {
              return (
                <li key={workspace.id}>
                  <input
                    autoFocus
                    defaultValue={workspace.name}
                    aria-label="Workspace name"
                    className="h-7 w-full rounded-md border border-sidebar-border bg-transparent px-2 text-sm text-sidebar-foreground outline-none focus:border-ring"
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={(event) => {
                      renameWorkspace(workspace.id, event.currentTarget.value);
                      setRenamingId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={workspace.id} className="group/workspace relative">
                <button
                  type="button"
                  disabled={busy}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 pr-14 text-left text-sm",
                    active
                      ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    busy && "cursor-default opacity-50 hover:bg-transparent",
                  )}
                  onClick={() => followLayout(switchWorkspace(workspace.id))}
                  onDoubleClick={() => setRenamingId(workspace.id)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      active ? "bg-primary" : "bg-sidebar-muted-foreground/40",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {busy ? (
                    <span className="shrink-0 text-2xs text-sidebar-muted-foreground">
                      other window
                    </span>
                  ) : null}
                </button>
                {busy ? null : (
                  <div className="absolute inset-y-0 right-1 hidden items-center gap-0.5 group-hover/workspace:flex">
                    <button
                      type="button"
                      className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-border/60 hover:text-sidebar-foreground"
                      aria-label={`Rename ${workspace.name}`}
                      onClick={() => setRenamingId(workspace.id)}
                    >
                      <PencilIcon className="size-3" />
                    </button>
                    {workspaces.length > 1 ? (
                      <button
                        type="button"
                        className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-border/60 hover:text-destructive-foreground"
                        aria-label={`Delete ${workspace.name}`}
                        onClick={() => followLayout(deleteWorkspace(workspace.id))}
                      >
                        <XIcon className="size-3" />
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
