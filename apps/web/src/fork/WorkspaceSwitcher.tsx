/* oxlint-disable t3code/no-untranslated-copy -- fork UI is English-only; translating it would touch upstream locale catalogs every sync */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMessages } from "gt-react";
import { ChevronRightIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import { ProjectMonogram } from "../components/ProjectMonogram";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { cn } from "../lib/utils";
import { deriveProjectIdentity } from "../projectIdentity";
import { useThreadShells } from "../state/entities";
import { classifyStatusPill, type TabActivity } from "./workspaces.logic";
import { navigateToLayout, openWorkspaceTab, type RouteNavigate } from "./workspaceNavigation";
import {
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  switchWorkspace,
  useWorkspacesStore,
  type WorkspaceSummary,
} from "./workspacesStore";

const EXPANDED_KEY = "t3code:fork-workspaces-expanded";
const OPEN_WORKSPACES_KEY = "t3code:fork-workspaces-open";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function readOpenIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(OPEN_WORKSPACES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface TabStatus {
  readonly title: string;
  readonly pill: ThreadStatusPill | null;
  readonly activity: TabActivity | null;
}

const BADGE_ORDER: readonly TabActivity[] = ["wait", "error", "run", "done"];
const BADGE_CLASS: Record<TabActivity, string> = {
  wait: "bg-warning/15 text-warning-foreground",
  error: "bg-destructive/15 text-destructive-foreground",
  run: "bg-info/15 text-info-foreground",
  done: "bg-success/15 text-success-foreground",
};
const BADGE_GLYPH: Record<TabActivity, string> = { wait: "!", error: "✕", run: "⟳", done: "✓" };

/**
 * Fork: the workspace list at the top of the sidebar. A workspace is a saved tab/split
 * layout; whatever is opened or arranged goes into the selected one. Every row sums up
 * what its tabs are doing, and every workspace expands to list its tabs (in layout
 * order, never re-sorted by status) so work in the background stays visible.
 */
export function WorkspaceSwitcher() {
  const navigateRaw = useNavigate();
  const navigate: RouteNavigate = (options) => navigateRaw(options as never);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeId = useWorkspacesStore((state) => state.activeId);
  const busyIds = useWorkspacesStore((state) => state.busyIds);
  const shells = useThreadShells();
  const [expanded, setExpanded] = useState(() => readFlag(EXPANDED_KEY, true));
  const [openIds, setOpenIds] = useState(readOpenIds);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const statusByKey = new Map<string, TabStatus>();
  for (const shell of shells) {
    const pill = resolveThreadStatusPill({ thread: shell });
    statusByKey.set(scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }), {
      title: shell.title,
      pill,
      activity: classifyStatusPill(pill),
    });
  }

  const statusOf = (tab: ScopedThreadRef): TabStatus =>
    statusByKey.get(scopedThreadKey(tab)) ?? { title: "New thread", pill: null, activity: null };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, String(next));
    } catch {}
  };

  const toggleOpen = (id: string) => {
    const next = openIds.includes(id) ? openIds.filter((entry) => entry !== id) : [...openIds, id];
    setOpenIds(next);
    try {
      localStorage.setItem(OPEN_WORKSPACES_KEY, JSON.stringify(next));
    } catch {}
  };

  const addWorkspace = () => {
    navigateToLayout(createWorkspace(), navigate);
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
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              active={workspace.id === activeId}
              busy={busyIds.includes(workspace.id)}
              open={openIds.includes(workspace.id)}
              renaming={renamingId === workspace.id}
              canDelete={workspaces.length > 1}
              statusOf={statusOf}
              onToggleOpen={() => toggleOpen(workspace.id)}
              onSwitch={() => navigateToLayout(switchWorkspace(workspace.id), navigate)}
              onOpenTab={(tab) => openWorkspaceTab(workspace.id, tab, navigate)}
              onStartRename={() => setRenamingId(workspace.id)}
              onFinishRename={(name) => {
                if (name !== null) renameWorkspace(workspace.id, name);
                setRenamingId(null);
              }}
              onDelete={() => navigateToLayout(deleteWorkspace(workspace.id), navigate)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WorkspaceRow(props: {
  workspace: WorkspaceSummary;
  active: boolean;
  busy: boolean;
  open: boolean;
  renaming: boolean;
  canDelete: boolean;
  statusOf: (tab: ScopedThreadRef) => TabStatus;
  onToggleOpen: () => void;
  onSwitch: () => void;
  onOpenTab: (tab: ScopedThreadRef) => void;
  onStartRename: () => void;
  onFinishRename: (name: string | null) => void;
  onDelete: () => void;
}) {
  const { workspace, active, busy } = props;
  const statuses = workspace.tabs.map((tab) => ({ tab, status: props.statusOf(tab) }));
  const counts = new Map<TabActivity, number>();
  for (const { status } of statuses) {
    if (status.activity) counts.set(status.activity, (counts.get(status.activity) ?? 0) + 1);
  }
  const canOpen = workspace.tabs.length > 0;
  const showTabs = canOpen && props.open;

  if (props.renaming) {
    return (
      <li>
        <input
          autoFocus
          defaultValue={workspace.name}
          aria-label="Workspace name"
          className="h-7 w-full rounded-md border border-sidebar-border bg-transparent px-2 text-sm text-sidebar-foreground outline-none focus:border-ring"
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => props.onFinishRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") props.onFinishRename(null);
          }}
        />
      </li>
    );
  }

  return (
    <li>
      <div className="group/workspace relative flex items-center">
        <button
          type="button"
          aria-label={
            props.open ? `Hide tabs of ${workspace.name}` : `Show tabs of ${workspace.name}`
          }
          aria-expanded={showTabs}
          disabled={!canOpen}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-sidebar-muted-foreground hover:text-sidebar-foreground",
            !canOpen && "invisible",
          )}
          onClick={props.onToggleOpen}
        >
          <ChevronRightIcon
            className={cn("size-3 transition-transform", showTabs && "rotate-90")}
          />
        </button>
        <button
          type="button"
          disabled={busy}
          aria-current={active ? "true" : undefined}
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm",
            active
              ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            busy && "cursor-default opacity-60 hover:bg-transparent",
          )}
          onClick={props.onSwitch}
          onDoubleClick={props.onStartRename}
        >
          <WorkspaceMonogram name={workspace.name} />
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
          {busy ? (
            <span className="shrink-0 text-2xs font-normal text-sidebar-muted-foreground">
              other window
            </span>
          ) : null}
          <span className={cn("flex shrink-0 gap-1", !busy && "group-hover/workspace:invisible")}>
            {BADGE_ORDER.filter((activity) => counts.has(activity)).map((activity) => (
              <span
                key={activity}
                className={cn(
                  "inline-flex h-4 items-center gap-0.5 rounded-full px-1.5 text-2xs font-semibold tabular-nums",
                  BADGE_CLASS[activity],
                )}
              >
                <span aria-hidden>{BADGE_GLYPH[activity]}</span>
                {counts.get(activity)}
              </span>
            ))}
          </span>
        </button>
        {busy ? null : (
          <div className="absolute inset-y-0 right-1 hidden items-center gap-0.5 group-hover/workspace:flex">
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-border/60 hover:text-sidebar-foreground"
              aria-label={`Rename ${workspace.name}`}
              onClick={props.onStartRename}
            >
              <PencilIcon className="size-3" />
            </button>
            {props.canDelete ? (
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-border/60 hover:text-destructive-foreground"
                aria-label={`Delete ${workspace.name}`}
                onClick={props.onDelete}
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
        )}
      </div>
      {showTabs ? (
        <ul
          className="mb-1 ml-[19px] flex flex-col border-l border-sidebar-border pl-1.5"
          aria-label={`Tabs of ${workspace.name}`}
        >
          {statuses.map(({ tab, status }) => (
            <WorkspaceTabRow
              key={scopedThreadKey(tab)}
              status={status}
              disabled={busy}
              onOpen={() => props.onOpenTab(tab)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WorkspaceTabRow(props: { status: TabStatus; disabled: boolean; onOpen: () => void }) {
  const m = useMessages();
  const { title, pill, activity } = props.status;
  return (
    <li>
      <button
        type="button"
        disabled={props.disabled}
        className={cn(
          "flex h-6 w-full min-w-0 items-center gap-2 rounded px-1.5 text-left text-xs",
          activity === "done"
            ? "font-semibold text-sidebar-foreground"
            : "text-sidebar-foreground/75",
          props.disabled
            ? "cursor-default"
            : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={props.onOpen}
      >
        <TabActivityIcon pill={pill} activity={activity} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {pill && activity ? (
          <span className={cn("shrink-0 text-2xs font-normal", pill.colorClass)}>
            {m(pill.label)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function TabActivityIcon(props: { pill: ThreadStatusPill | null; activity: TabActivity | null }) {
  if (props.activity === "run") {
    return (
      <span
        aria-hidden
        className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-info/30 border-t-info"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.pill && props.activity
          ? props.pill.dotClass
          : "border border-sidebar-muted-foreground/60 bg-transparent",
      )}
    />
  );
}

/** Same coloured monogram projects get, derived from the workspace name. */
function WorkspaceMonogram(props: { name: string }) {
  const identity = deriveProjectIdentity(props.name);
  return <ProjectMonogram text={identity.monogram} color={identity.color} />;
}
