/* oxlint-disable t3code/no-untranslated-copy -- fork UI is English-only; translating it would touch upstream locale catalogs every sync */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProjectIconOverride,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMessages } from "gt-react";
import { BotIcon, ImageIcon, PencilIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../components/ProjectFavicon";
import { ProjectMonogram } from "../components/ProjectMonogram";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { cn } from "../lib/utils";
import { deriveProjectIdentity } from "../projectIdentity";
import { useProject, useProjects, useThreadShells } from "../state/entities";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useAtomValue } from "@effect/atom-react";
import {
  classifyStatusPill,
  isBackgroundWorkPill,
  threadWorkspaceIds,
  type TabActivity,
} from "./workspaces.logic";
import { membershipContext, rootThreadKey } from "./useForkWorkspaceThreads";
import { WorkspaceServerSync } from "./WorkspaceServerSync";
import { forkEnvironmentKey, forkThreadTagsAtom } from "./workspaceServer";
import { navigateToLayout, openWorkspaceTab, type RouteNavigate } from "./workspaceNavigation";
import {
  createWorkspace,
  deleteWorkspace,
  moveWorkspace,
  renameWorkspace,
  setDefaultWorkspace,
  setWorkspaceIcon,
  switchWorkspace,
  useWorkspacesStore,
  type WorkspaceIcon,
  type WorkspaceSummary,
} from "./workspacesStore";

const ProjectIconPickerDialog = lazy(() =>
  import("../components/settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/** Drag payload type, so file drops and other drags are ignored. */
const WORKSPACE_DRAG_TYPE = "application/x-t3-fork-workspace";

/** Uploaded pictures are cropped to a square this size and kept inline. */
const ICON_IMAGE_SIZE = 64;

const EXPANDED_KEY = "t3code:fork-workspaces-expanded";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

interface TabStatus {
  readonly title: string;
  readonly pill: ThreadStatusPill | null;
  readonly activity: TabActivity | null;
  /** Subagents still running for the thread. */
  readonly subagents: number;
  /** Agent background commands and monitors still running. */
  readonly commands: number;
}

const IDLE_TAB: Omit<TabStatus, "title"> = {
  pill: null,
  activity: null,
  subagents: 0,
  commands: 0,
};

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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Drag to reorder: the dragged workspace and where it would land.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

  const endDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const drop = () => {
    if (dragId && dropTarget) {
      const index = workspaces.findIndex((workspace) => workspace.id === dropTarget.id);
      const beforeId = dropTarget.after ? (workspaces[index + 1]?.id ?? null) : dropTarget.id;
      moveWorkspace(dragId, beforeId);
    }
    endDrag();
  };

  const statusByKey = new Map<string, TabStatus>();
  for (const shell of shells) {
    const pill = resolveThreadStatusPill({ thread: shell });
    const tasks = shell.pendingBackgroundTasks ?? [];
    statusByKey.set(scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }), {
      title: shell.title,
      pill,
      activity: classifyStatusPill(pill),
      subagents: tasks.filter((task) => task.kind === "subagent").length,
      commands: tasks.filter((task) => task.kind === "command" || task.kind === "monitor").length,
    });
  }

  const defaultId = useWorkspacesStore((state) => state.defaultId);
  const registryReady = useWorkspacesStore((state) => state.registryReady);
  const threadTags = useAtomValue(
    forkThreadTagsAtom(forkEnvironmentKey(shells.map((shell) => shell.environmentId))),
  );
  // Each workspace's activity: its member threads plus its open tabs, each thread once.
  const membersByWorkspace = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    membersByWorkspace.set(
      workspace.id,
      new Set(workspace.tabs.map((tab) => scopedThreadKey(tab))),
    );
  }
  if (registryReady && defaultId !== null) {
    const context = membershipContext(
      workspaces.map((workspace) => workspace.id),
      defaultId,
      threadTags,
    );
    for (const shell of shells) {
      const key = scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id });
      for (const id of threadWorkspaceIds(key, rootThreadKey(shell), context)) {
        membersByWorkspace.get(id)?.add(key);
      }
    }
  }
  const activitiesOf = (workspaceId: string): TabActivity[] =>
    [...(membersByWorkspace.get(workspaceId) ?? [])].flatMap((key) => {
      const activity = statusByKey.get(key)?.activity;
      return activity ? [activity] : [];
    });

  const statusOf = (tab: ScopedThreadRef): TabStatus =>
    statusByKey.get(scopedThreadKey(tab)) ?? { title: "New thread", ...IDLE_TAB };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, String(next));
    } catch {}
  };

  const addWorkspace = () => {
    navigateToLayout(createWorkspace(), navigate);
    setRenamingId(useWorkspacesStore.getState().activeId);
    if (!expanded) toggle();
  };

  return (
    <div className="px-2 pb-1">
      <WorkspaceServerSync />
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
              renaming={renamingId === workspace.id}
              canDelete={workspaces.length > 1}
              statusOf={statusOf}
              activities={activitiesOf(workspace.id)}
              onSwitch={() => navigateToLayout(switchWorkspace(workspace.id), navigate)}
              onOpenTab={(tab) => openWorkspaceTab(workspace.id, tab, navigate)}
              onStartRename={() => setRenamingId(workspace.id)}
              onFinishRename={(name) => {
                if (name !== null) renameWorkspace(workspace.id, name);
                setRenamingId(null);
              }}
              onDelete={() => navigateToLayout(deleteWorkspace(workspace.id), navigate)}
              onSetIcon={(icon) => setWorkspaceIcon(workspace.id, icon)}
              isDefault={workspace.id === defaultId}
              onMakeDefault={() => setDefaultWorkspace(workspace.id)}
              dragging={dragId === workspace.id}
              dropEdge={
                dragId !== null && dropTarget?.id === workspace.id && dragId !== workspace.id
                  ? dropTarget.after
                    ? "after"
                    : "before"
                  : null
              }
              onDragStart={() => setDragId(workspace.id)}
              onDragOver={(after) => dragId !== null && setDropTarget({ id: workspace.id, after })}
              onDragEnd={endDrag}
              onDrop={drop}
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
  renaming: boolean;
  canDelete: boolean;
  statusOf: (tab: ScopedThreadRef) => TabStatus;
  /** Activity of every thread in the workspace (members and open tabs), for the badges. */
  activities: ReadonlyArray<TabActivity>;
  onSwitch: () => void;
  onOpenTab: (tab: ScopedThreadRef) => void;
  onStartRename: () => void;
  onFinishRename: (name: string | null) => void;
  onDelete: () => void;
  onSetIcon: (icon: WorkspaceIcon | null) => void;
  isDefault: boolean;
  onMakeDefault: () => void;
  dragging: boolean;
  dropEdge: "before" | "after" | null;
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const { workspace, active, busy } = props;
  const headerRef = useRef<HTMLDivElement>(null);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const statuses = workspace.tabs.map((tab) => ({ tab, status: props.statusOf(tab) }));
  const counts = new Map<TabActivity, number>();
  for (const activity of props.activities) counts.set(activity, (counts.get(activity) ?? 0) + 1);
  const showTabs = workspace.tabs.length > 0;

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
    <li
      className={cn("relative", props.dragging && "opacity-50")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = headerRef.current?.getBoundingClientRect();
        props.onDragOver(rect ? event.clientY > rect.top + rect.height / 2 : true);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE)) return;
        event.preventDefault();
        props.onDrop();
      }}
    >
      {props.dropEdge ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
            props.dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      <div
        ref={headerRef}
        draggable
        className="group/workspace relative flex items-center"
        onDragStart={(event) => {
          event.dataTransfer.setData(WORKSPACE_DRAG_TYPE, workspace.id);
          event.dataTransfer.effectAllowed = "move";
          props.onDragStart();
        }}
        onDragEnd={props.onDragEnd}
      >
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
          <WorkspaceIconView name={workspace.name} icon={workspace.icon} />
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
          <div
            className={cn(
              "absolute inset-y-0 right-1 items-center gap-0.5 group-hover/workspace:flex",
              iconMenuOpen ? "flex" : "hidden",
            )}
          >
            <WorkspaceIconMenu
              name={workspace.name}
              hasIcon={workspace.icon !== undefined}
              open={iconMenuOpen}
              onOpenChange={setIconMenuOpen}
              onChooseIcon={() => setPickerOpen(true)}
              onSetIcon={props.onSetIcon}
              isDefault={props.isDefault}
              onMakeDefault={props.onMakeDefault}
            />
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
          className="mb-1 ml-4 flex flex-col border-l border-sidebar-border pl-1.5"
          aria-label={`Tabs of ${workspace.name}`}
        >
          {statuses.map(({ tab, status }) => (
            <WorkspaceTabRow
              key={scopedThreadKey(tab)}
              tab={tab}
              status={status}
              disabled={busy}
              onOpen={() => props.onOpenTab(tab)}
            />
          ))}
        </ul>
      ) : null}
      {pickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={workspace.icon?.kind === "override" ? workspace.icon.icon : null}
            projectName={workspace.name}
            open
            onOpenChange={setPickerOpen}
            onSelect={(icon: ProjectIconOverride) => props.onSetIcon({ kind: "override", icon })}
          />
        </Suspense>
      ) : null}
    </li>
  );
}

function WorkspaceTabRow(props: {
  tab: ScopedThreadRef;
  status: TabStatus;
  disabled: boolean;
  onOpen: () => void;
}) {
  const m = useMessages();
  const { title, pill, activity, subagents, commands } = props.status;
  const terminals = useThreadRunningTerminalIds({
    environmentId: props.tab.environmentId,
    threadId: props.tab.threadId,
  }).length;
  // Only states that need you get words; work in progress shows as icon counts.
  const showLabel = pill !== null && (activity === "wait" || activity === "error");
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
        {showLabel && pill ? (
          <span className={cn("shrink-0 text-2xs font-normal", pill.colorClass)}>
            {m(pill.label)}
          </span>
        ) : null}
        <TabWorkCount icon={BotIcon} count={subagents} label="subagents running" />
        <TabWorkCount icon={TerminalIcon} count={commands + terminals} label="commands running" />
      </button>
    </li>
  );
}

function TabActivityIcon(props: { pill: ThreadStatusPill | null; activity: TabActivity | null }) {
  if (props.activity === "run") {
    // A finished turn waiting on subagents or background work spins dotted.
    return (
      <span
        aria-hidden
        className={cn(
          "size-2.5 shrink-0 animate-spin rounded-full border-2",
          isBackgroundWorkPill(props.pill)
            ? "border-dotted border-info/70"
            : "border-info/30 border-t-info",
        )}
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

function TabWorkCount(props: { icon: typeof BotIcon; count: number; label: string }) {
  if (props.count === 0) return null;
  const Icon = props.icon;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-normal text-sidebar-muted-foreground tabular-nums"
      aria-label={`${props.count} ${props.label}`}
    >
      <Icon className="size-3" aria-hidden />
      {props.count}
    </span>
  );
}

/** The workspace's picture, else the coloured monogram projects get, from its name. */
function WorkspaceIconView(props: { name: string; icon: WorkspaceIcon | undefined }) {
  const { icon } = props;
  if (icon?.kind === "image") {
    return (
      <img
        src={icon.dataUrl}
        alt=""
        aria-hidden
        className="size-4 shrink-0 rounded-[25%] object-cover"
      />
    );
  }
  if (icon?.kind === "override") {
    return <ProjectFavicon project={iconOnlyProject(props.name, icon.icon)} />;
  }
  if (icon?.kind === "project") {
    return (
      <LinkedProjectIcon
        name={props.name}
        environmentId={icon.environmentId}
        projectId={icon.projectId}
      />
    );
  }
  const identity = deriveProjectIdentity(props.name);
  return <ProjectMonogram text={identity.monogram} color={identity.color} />;
}

function LinkedProjectIcon(props: { name: string; environmentId: string; projectId: string }) {
  const project = useProject({
    environmentId: props.environmentId as EnvironmentId,
    projectId: props.projectId as ProjectId,
  });
  if (project) return <ProjectFavicon project={project} />;
  const identity = deriveProjectIdentity(props.name);
  return <ProjectMonogram text={identity.monogram} color={identity.color} />;
}

/** ProjectFavicon renders an override from `projectIcon` alone; the rest is filler. */
function iconOnlyProject(name: string, icon: ProjectIconOverride): ProjectFaviconProject {
  return {
    environmentId: "" as EnvironmentId,
    workspaceRoot: "",
    title: name,
    faviconPath: null,
    projectIcon: icon,
  } as ProjectFaviconProject;
}

/** Reads an image file and crops it to a centred square data URL. */
async function imageFileToIconDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = ICON_IMAGE_SIZE;
  canvas.height = ICON_IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    ICON_IMAGE_SIZE,
    ICON_IMAGE_SIZE,
  );
  bitmap.close();
  return canvas.toDataURL("image/png");
}

function WorkspaceIconMenu(props: {
  name: string;
  hasIcon: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseIcon: () => void;
  onSetIcon: (icon: WorkspaceIcon | null) => void;
  isDefault: boolean;
  onMakeDefault: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projects = useProjects();
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          void imageFileToIconDataUrl(file)
            .then((dataUrl) => props.onSetIcon({ kind: "image", dataUrl }))
            .catch((error: unknown) => console.error("Could not read the image.", error));
        }}
      />
      <Menu open={props.open} onOpenChange={props.onOpenChange}>
        <MenuTrigger
          render={
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-border/60 hover:text-sidebar-foreground"
            />
          }
          aria-label={`Change icon of ${props.name}`}
        >
          <ImageIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-48">
          <MenuItem onClick={props.onChooseIcon}>Choose icon…</MenuItem>
          <MenuItem onClick={() => fileInputRef.current?.click()}>Choose file…</MenuItem>
          {projects.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>Use a project's icon</MenuSubTrigger>
              <MenuSubPopup className="max-h-80 min-w-52 overflow-y-auto">
                {projects.map((project) => (
                  <MenuItem
                    key={`${project.environmentId}:${project.id}`}
                    onClick={() =>
                      props.onSetIcon({
                        kind: "project",
                        environmentId: project.environmentId,
                        projectId: project.id,
                      })
                    }
                  >
                    <ProjectFavicon project={project} />
                    <span className="min-w-0 truncate">{project.title}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {props.hasIcon ? (
            <MenuItem onClick={() => props.onSetIcon(null)}>Use name monogram</MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem disabled={props.isDefault} onClick={props.onMakeDefault}>
            {props.isDefault ? "Default workspace" : "Make default workspace"}
            <MenuItemDetail>holds threads without a workspace</MenuItemDetail>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
