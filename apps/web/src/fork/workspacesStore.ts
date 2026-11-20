import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { randomUUID } from "../lib/utils";
import {
  EMPTY_PANE_LAYOUT,
  PANE_LAYOUT_VERSION,
  decodePaneLayout,
  snapshotPaneLayout,
  useChatPanesStore,
  type PaneLayout,
} from "./chatPanesStore";
import { findLeafByThreadKey } from "./chatPanes.logic";
import {
  layoutTabs,
  nextWorkspaceName,
  pickWorkspaceForWindow,
  withoutDraftTabs,
} from "./workspaces.logic";

// Workspaces: named tab/split layouts, kept in localStorage. Each window works in one
// workspace at a time and a workspace is open in one window at most (lease below).
// Writes re-read storage first and change only what this window owns, so windows never
// overwrite each other's workspaces.

const WORKSPACES_KEY = "t3code:fork-workspaces:v1";
const LEASES_KEY = "t3code:fork-workspace-leases:v1";
/** The pane layout before workspaces existed; it becomes the Default workspace. */
const LEGACY_PANES_KEY = "t3code:fork-chat-panes:v1";
const SESSION_ACTIVE_KEY = "t3code:fork-active-workspace";
const SESSION_TOKEN_KEY = "t3code:fork-window-token";
// Keep in sync with ../windowProjectScope.ts (read here because this runs first).
const WINDOW_SCOPE_SESSION_KEY = "t3code:window-project-scope:v1";
const PROJECT_SCOPE_URL_PARAM = "projectScope";

const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_STALE_MS = 45_000;

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly layout: PaneLayout;
}

interface StoredWorkspaces {
  readonly workspaces: readonly Workspace[];
  /** The main window's workspace, restored on the next launch. */
  readonly mainActiveId: string | null;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  /** Tabs in layout order (never re-sorted by activity). */
  readonly tabs: readonly ScopedThreadRef[];
}

type Leases = Record<string, { readonly token: string; readonly at: number }>;

interface WorkspacesState {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly activeId: string;
  /** Workspace ids open in another live window. */
  readonly busyIds: readonly string[];
}

export const useWorkspacesStore = create<WorkspacesState>(() => ({
  workspaces: [],
  activeId: "",
  busyIds: [],
}));

function readJson(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readStored(): StoredWorkspaces {
  const raw = readJson(localStorage, WORKSPACES_KEY) as
    | { workspaces?: unknown; mainActiveId?: unknown }
    | undefined;
  const workspaces: Workspace[] = [];
  if (raw && Array.isArray(raw.workspaces)) {
    for (const entry of raw.workspaces as { id?: unknown; name?: unknown; layout?: unknown }[]) {
      if (typeof entry?.id !== "string" || typeof entry.name !== "string") continue;
      const layout = decodePaneLayout(entry.layout, PANE_LAYOUT_VERSION) ?? EMPTY_PANE_LAYOUT;
      workspaces.push({ id: entry.id, name: entry.name, layout });
    }
  }
  const mainActiveId = typeof raw?.mainActiveId === "string" ? raw.mainActiveId : null;
  return { workspaces, mainActiveId };
}

function writeStored(stored: StoredWorkspaces): void {
  writeJson(localStorage, WORKSPACES_KEY, stored);
}

function readLegacyLayout(): PaneLayout {
  const raw = readJson(localStorage, LEGACY_PANES_KEY) as
    | { state?: unknown; version?: unknown }
    | undefined;
  if (!raw) return EMPTY_PANE_LAYOUT;
  const version = typeof raw.version === "number" ? raw.version : 0;
  return decodePaneLayout(raw.state, version) ?? EMPTY_PANE_LAYOUT;
}

function isSecondaryAppWindow(): boolean {
  const stored = readJson(sessionStorage, WINDOW_SCOPE_SESSION_KEY);
  if (typeof stored === "object" && stored !== null && "secondary" in stored) {
    return stored.secondary === true;
  }
  return new URLSearchParams(window.location.search).has(PROJECT_SCOPE_URL_PARAM);
}

function windowToken(): string {
  const existing = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (existing) return existing;
  const token = randomUUID();
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {}
  return token;
}

function readLeases(): Leases {
  const raw = readJson(localStorage, LEASES_KEY);
  return typeof raw === "object" && raw !== null ? (raw as Leases) : {};
}

function busyIdsFor(token: string, leases: Leases = readLeases()): string[] {
  const now = Date.now();
  return Object.entries(leases)
    .filter(([, lease]) => lease.token !== token && now - lease.at < LEASE_STALE_MS)
    .map(([id]) => id);
}

let token = "";
let secondary = false;
let started = false;
/** Set while a layout is being loaded, so the save subscription skips it. */
let loading = false;

function claimLease(id: string, releaseId?: string): void {
  const leases = readLeases();
  if (releaseId && leases[releaseId]?.token === token) delete leases[releaseId];
  leases[id] = { token, at: Date.now() };
  writeJson(localStorage, LEASES_KEY, leases);
}

function releaseLease(): void {
  const leases = readLeases();
  const id = useWorkspacesStore.getState().activeId;
  if (leases[id]?.token !== token) return;
  delete leases[id];
  writeJson(localStorage, LEASES_KEY, leases);
}

function publish(stored: StoredWorkspaces, activeId: string): void {
  useWorkspacesStore.setState({
    workspaces: stored.workspaces.map(({ id, name, layout }) => ({
      id,
      name,
      tabs: layoutTabs(layout),
    })),
    activeId,
    busyIds: busyIdsFor(token),
  });
}

/** Re-reads storage, applies `change`, writes it back and refreshes this window's view. */
function updateStored(change: (stored: StoredWorkspaces) => StoredWorkspaces): StoredWorkspaces {
  const next = change(readStored());
  writeStored(next);
  publish(next, useWorkspacesStore.getState().activeId);
  return next;
}

function saveActiveLayout(): void {
  const activeId = useWorkspacesStore.getState().activeId;
  if (!activeId) return;
  const layout = snapshotPaneLayout();
  const busy = new Set(busyIdsFor(token));
  updateStored((stored) => ({
    ...stored,
    workspaces: stored.workspaces.map((workspace) =>
      workspace.id === activeId
        ? { ...workspace, layout }
        : busy.has(workspace.id)
          ? workspace
          : { ...workspace, layout: withoutDraftTabs(workspace.layout, layout.draftTabKeys) },
    ),
  }));
}

function activate(stored: StoredWorkspaces, id: string, previousId?: string): PaneLayout {
  claimLease(id, previousId);
  try {
    sessionStorage.setItem(SESSION_ACTIVE_KEY, id);
  } catch {}
  const next = secondary ? stored : { ...stored, mainActiveId: id };
  if (next !== stored) writeStored(next);
  publish(next, id);
  const layout = next.workspaces.find((workspace) => workspace.id === id)?.layout;
  loading = true;
  useChatPanesStore.getState().loadLayout(layout ?? EMPTY_PANE_LAYOUT);
  loading = false;
  return layout ?? EMPTY_PANE_LAYOUT;
}

/** Picks this window's workspace and loads its layout. Runs once, before the first render. */
function startWorkspaces(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  token = windowToken();
  secondary = isSecondaryAppWindow();

  let stored = readStored();
  if (stored.workspaces.length === 0) {
    const id = randomUUID();
    stored = {
      workspaces: [{ id, name: "Default", layout: readLegacyLayout() }],
      mainActiveId: id,
    };
  }
  const busy = busyIdsFor(token);
  let id = pickWorkspaceForWindow({
    ids: stored.workspaces.map((workspace) => workspace.id),
    sessionId: sessionStorage.getItem(SESSION_ACTIVE_KEY),
    rememberedId: secondary ? null : stored.mainActiveId,
    busyIds: busy,
  });
  if (id === null) {
    // Every workspace is open in another window: this window gets a new one.
    id = randomUUID();
    const name = nextWorkspaceName(stored.workspaces.map((workspace) => workspace.name));
    stored = {
      ...stored,
      workspaces: [...stored.workspaces, { id, name, layout: EMPTY_PANE_LAYOUT }],
    };
  }
  writeStored(stored);
  activate(stored, id);

  useChatPanesStore.subscribe((state, previous) => {
    if (loading) return;
    if (
      state.root === previous.root &&
      state.focusedPaneId === previous.focusedPaneId &&
      state.history === previous.history &&
      state.draftTabKeys === previous.draftTabKeys
    ) {
      return;
    }
    saveActiveLayout();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === WORKSPACES_KEY || event.key === LEASES_KEY || event.key === null) {
      publish(readStored(), useWorkspacesStore.getState().activeId);
    }
  });
  window.setInterval(() => {
    claimLease(useWorkspacesStore.getState().activeId);
    useWorkspacesStore.setState({ busyIds: busyIdsFor(token) });
  }, LEASE_HEARTBEAT_MS);
  window.addEventListener("pagehide", releaseLease);
}

startWorkspaces();

/**
 * Makes `id` this window's workspace. Returns its layout so the caller can move the
 * route to its focused tab, or null when it is already active or open elsewhere.
 */
export function switchWorkspace(id: string): PaneLayout | null {
  const { activeId } = useWorkspacesStore.getState();
  if (id === activeId || busyIdsFor(token).includes(id)) return null;
  saveActiveLayout();
  const stored = readStored();
  if (!stored.workspaces.some((workspace) => workspace.id === id)) return null;
  return activate(stored, id, activeId);
}

/** Adds an empty workspace and switches to it. */
export function createWorkspace(name?: string): PaneLayout | null {
  const id = randomUUID();
  updateStored((stored) => ({
    ...stored,
    workspaces: [
      ...stored.workspaces,
      {
        id,
        name: name?.trim() || nextWorkspaceName(stored.workspaces.map((ws) => ws.name)),
        layout: EMPTY_PANE_LAYOUT,
      },
    ],
  }));
  return switchWorkspace(id);
}

export function renameWorkspace(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateStored((stored) => ({
    ...stored,
    workspaces: stored.workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, name: trimmed } : workspace,
    ),
  }));
}

/**
 * Deletes a workspace (never the last one, nor one open in another window). Deleting
 * the active one switches to a neighbour first; its layout is returned like switchWorkspace.
 */
export function deleteWorkspace(id: string): PaneLayout | null | false {
  const stored = readStored();
  if (stored.workspaces.length <= 1 || busyIdsFor(token).includes(id)) return false;
  let switched: PaneLayout | null = null;
  if (id === useWorkspacesStore.getState().activeId) {
    const busy = new Set(busyIdsFor(token));
    const index = stored.workspaces.findIndex((workspace) => workspace.id === id);
    const others = stored.workspaces.filter((workspace) => workspace.id !== id);
    const neighbour =
      others.slice(Math.max(0, index - 1)).find((workspace) => !busy.has(workspace.id)) ??
      others.find((workspace) => !busy.has(workspace.id));
    if (!neighbour) return false;
    switched = switchWorkspace(neighbour.id);
  }
  updateStored((current) => ({
    workspaces: current.workspaces.filter((workspace) => workspace.id !== id),
    mainActiveId: current.mainActiveId === id ? null : current.mainActiveId,
  }));
  return switched;
}

/** The workspace showing `threadRef` as a tab: this window's first, then any free one. */
export function findWorkspaceForThread(threadRef: ScopedThreadRef): string | null {
  const key = scopedThreadKey(threadRef);
  const { workspaces, activeId, busyIds } = useWorkspacesStore.getState();
  const holds = (workspace: WorkspaceSummary) =>
    workspace.tabs.some((tab) => scopedThreadKey(tab) === key);
  const active = workspaces.find((workspace) => workspace.id === activeId);
  if (active && holds(active)) return active.id;
  return (
    workspaces.find((workspace) => !busyIds.includes(workspace.id) && holds(workspace))?.id ?? null
  );
}

/**
 * Switches to `workspaceId` (if needed) and brings `threadRef`'s tab to the front of
 * its pane. Returns false when the workspace is open in another window.
 */
export function revealWorkspaceTab(workspaceId: string, threadRef: ScopedThreadRef): boolean {
  if (workspaceId !== useWorkspacesStore.getState().activeId) {
    if (switchWorkspace(workspaceId) === null) return false;
  }
  const panes = useChatPanesStore.getState();
  const key = scopedThreadKey(threadRef);
  const leaf = panes.root ? findLeafByThreadKey(panes.root, key) : null;
  if (leaf) panes.activateTab(leaf.id, key);
  return true;
}
