import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  ForkWorkspaceIcon,
  type ForkWorkspaceRegistry,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
  moveThreadTagChanges,
  nextWorkspaceName,
  threadWorkspaceIds,
  pickWorkspaceForWindow,
  reorderWorkspaces,
  withoutDraftTabs,
} from "./workspaces.logic";

// The registry (ids, names, icons, order, default) is the server's (fork/workspaceRegistry.ts);
// threads join through the tag `workspace:<id>`. Kept here: layouts, each window's workspace,
// a registry cache. Edits apply optimistically and go out with their base revision; a
// conflict re-applies them to the newer registry, so no client overwrites another's edit.

const WORKSPACES_KEY = "t3code:fork-workspaces:v1";
const LEASES_KEY = "t3code:fork-workspace-leases:v1";
/** The pane layout before workspaces existed; it becomes the Default workspace. */
const LEGACY_PANES_KEY = "t3code:fork-chat-panes:v1";
const SESSION_ACTIVE_KEY = "t3code:fork-active-workspace";
const SESSION_TOKEN_KEY = "t3code:fork-window-token";
// Keep in sync with ../windowProjectScope.ts (read here because this runs first).
const WINDOW_SCOPE_SESSION_KEY = "t3code:window-project-scope:v1";
const PROJECT_SCOPE_URL_PARAM = "projectScope";

const PENDING_TAGS_KEY = "t3code:fork-workspace-pending-tags:v1";
const PENDING_UNTAG_KEY = "t3code:fork-workspace-pending-untag:v1";
/** A draft that was never sent stops waiting for its tag after this long. */
const PENDING_TAG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_RETRY_MS = 3_000;
const REGISTRY_MAX_CONFLICTS = 5;

const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_STALE_MS = 45_000;

/** A workspace's picture; without one the row shows a monogram of its name. */
export type WorkspaceIcon = ForkWorkspaceIcon;

const decodeWorkspaceIconOption = Schema.decodeUnknownOption(ForkWorkspaceIcon);

function decodeWorkspaceIcon(raw: unknown): WorkspaceIcon | undefined {
  const icon = decodeWorkspaceIconOption(raw);
  return icon._tag === "Some" ? icon.value : undefined;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly layout: PaneLayout;
  readonly icon?: WorkspaceIcon;
}

interface StoredWorkspaces {
  readonly workspaces: readonly Workspace[];
  /** The main window's workspace, restored on the next launch. */
  readonly mainActiveId: string | null;
  /** Cached from the registry; holds threads without a known workspace tag. */
  readonly defaultWorkspaceId?: string | null;
}

/** The server registry, as the client sees it (revision -1: not from the server yet). */
export type RegistryValue = ForkWorkspaceRegistry;

type RegistryChange = (registry: RegistryValue) => RegistryValue;

export type RegistryWriter = (input: {
  readonly expectedRevision: number;
  readonly workspaces: RegistryValue["workspaces"];
  readonly defaultWorkspaceId: string;
}) => Promise<{ readonly applied: boolean; readonly registry: RegistryValue } | null>;

/** Sets or clears one tag on a thread; resolves false when the server did not take it. */
export type ThreadTagWriter = (
  threadRef: ScopedThreadRef,
  tag: string,
  tagged: boolean,
) => Promise<boolean>;

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  /** Tabs in layout order (never re-sorted by activity). */
  readonly tabs: readonly ScopedThreadRef[];
  readonly icon?: WorkspaceIcon;
}

type Leases = Record<string, { readonly token: string; readonly at: number }>;

interface WorkspacesState {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly activeId: string;
  /** Workspace ids open in another live window. */
  readonly busyIds: readonly string[];
  readonly defaultId: string | null;
  /** True once the server registry arrived; until then nothing is filtered. */
  readonly registryReady: boolean;
}

export const useWorkspacesStore = create<WorkspacesState>(() => ({
  workspaces: [],
  activeId: "",
  busyIds: [],
  defaultId: null,
  registryReady: false,
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
    for (const entry of raw.workspaces as {
      id?: unknown;
      name?: unknown;
      layout?: unknown;
      icon?: unknown;
    }[]) {
      if (typeof entry?.id !== "string" || typeof entry.name !== "string") continue;
      const layout = decodePaneLayout(entry.layout, PANE_LAYOUT_VERSION) ?? EMPTY_PANE_LAYOUT;
      const icon = decodeWorkspaceIcon(entry.icon);
      workspaces.push({ id: entry.id, name: entry.name, layout, ...(icon ? { icon } : {}) });
    }
  }
  const mainActiveId = typeof raw?.mainActiveId === "string" ? raw.mainActiveId : null;
  const rawDefault = (raw as { defaultWorkspaceId?: unknown } | undefined)?.defaultWorkspaceId;
  const defaultWorkspaceId = typeof rawDefault === "string" ? rawDefault : null;
  return { workspaces, mainActiveId, defaultWorkspaceId };
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
    defaultId: stored.defaultWorkspaceId ?? cachedDefaultId(stored),
    workspaces: stored.workspaces.map(({ id, name, layout, icon }) => ({
      id,
      name,
      tabs: layoutTabs(layout),
      ...(icon ? { icon } : {}),
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
    if (state.draftTabKeys !== previous.draftTabKeys) {
      recordDraftTabs(state.draftTabKeys.filter((key) => !previous.draftTabKeys.includes(key)));
    }
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
    if (event.key === PENDING_TAGS_KEY || event.key === PENDING_UNTAG_KEY) notifyMembershipWork();
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

// `serverRegistry` is the last one the server confirmed; `pending` are unconfirmed edits.
// The window shows the server registry with them applied, so a newer one never drops an edit.

let serverRegistry: RegistryValue | null = null;
const pending: RegistryChange[] = [];
let registryWriter: RegistryWriter | null = null;
let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let seedQueued = false;
/** Called with the layout to follow when this window's workspace disappears. */
let onActiveReplaced: ((layout: PaneLayout) => void) | null = null;

function localRegistry(): RegistryValue {
  const stored = readStored();
  return {
    revision: -1,
    workspaces: stored.workspaces.map(({ id, name, icon }) => ({
      id,
      name,
      ...(icon ? { icon } : {}),
    })),
    defaultWorkspaceId: stored.defaultWorkspaceId ?? cachedDefaultId(stored),
  };
}

/** Before the registry knows a default: the one named "Default" (the first ever), else the first. */
function cachedDefaultId(stored: StoredWorkspaces): string | null {
  return (
    stored.workspaces.find((workspace) => workspace.name === "Default")?.id ??
    stored.workspaces[0]?.id ??
    null
  );
}

/** The registry this window shows: the server's (or the cached one) plus unconfirmed edits. */
function viewRegistry(): RegistryValue {
  return pending.reduce((registry, change) => change(registry), serverRegistry ?? localRegistry());
}

/** Writes the shown registry into the local cache, keeping each workspace's layout. */
function applyView(): void {
  const view = viewRegistry();
  const before = readStored();
  const layouts = new Map(before.workspaces.map((workspace) => [workspace.id, workspace.layout]));
  const next = updateStored((stored) => ({
    ...stored,
    workspaces: view.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      layout: layouts.get(workspace.id) ?? EMPTY_PANE_LAYOUT,
      ...(workspace.icon ? { icon: workspace.icon } : {}),
    })),
    defaultWorkspaceId: view.defaultWorkspaceId,
  }));
  useWorkspacesStore.setState({ registryReady: serverRegistry !== null });
  const { activeId } = useWorkspacesStore.getState();
  if (
    next.workspaces.length > 0 &&
    !next.workspaces.some((workspace) => workspace.id === activeId)
  ) {
    // This window's workspace was deleted (here or elsewhere): move to the default one.
    const busy = new Set(busyIdsFor(token));
    const target =
      next.workspaces.find(
        (workspace) => workspace.id === next.defaultWorkspaceId && !busy.has(workspace.id),
      ) ?? next.workspaces.find((workspace) => !busy.has(workspace.id));
    if (target) {
      const layout = activate(next, target.id, activeId);
      onActiveReplaced?.(layout);
    }
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
  }, REGISTRY_RETRY_MS);
}

/** Sends pending changes one at a time, each against the registry the server last confirmed. */
async function flush(): Promise<void> {
  if (flushing || registryWriter === null || serverRegistry === null) return;
  flushing = true;
  try {
    let conflicts = 0;
    while (pending.length > 0 && serverRegistry !== null) {
      // The writer can go away while a request is out (the sync component unmounted).
      const writer: RegistryWriter | null = registryWriter;
      if (writer === null) return;
      const change = pending[0]!;
      const next = change(serverRegistry);
      if (next.workspaces.length === 0 || next.defaultWorkspaceId === null) {
        // A change that would leave no workspace is dropped, never sent.
        pending.shift();
        continue;
      }
      const result = await writer({
        expectedRevision: serverRegistry.revision,
        workspaces: next.workspaces,
        defaultWorkspaceId: next.defaultWorkspaceId,
      });
      if (result === null) {
        scheduleRetry();
        return;
      }
      if (result.registry.revision >= serverRegistry.revision) serverRegistry = result.registry;
      if (result.applied) {
        pending.shift();
        conflicts = 0;
      } else if (++conflicts > REGISTRY_MAX_CONFLICTS) {
        scheduleRetry();
        return;
      }
      applyView();
    }
  } finally {
    flushing = false;
  }
}

function commit(change: RegistryChange): void {
  pending.push(change);
  applyView();
  void flush();
}

/** The registry the server streams; also seeds an empty server from this machine's list. */
export function receiveServerRegistry(registry: RegistryValue): void {
  if (serverRegistry !== null && registry.revision < serverRegistry.revision) return;
  serverRegistry = registry;
  if (registry.workspaces.length === 0 && !seedQueued) {
    // First run against this server: upload the local workspaces with their ids, so the
    // layouts saved under those ids stay theirs. Another client may seed first; then the
    // change merges into what it wrote.
    seedQueued = true;
    const local = localRegistry();
    pending.unshift((current) => {
      const known = new Set(current.workspaces.map((workspace) => workspace.id));
      const workspaces = [
        ...current.workspaces,
        ...local.workspaces.filter((workspace) => !known.has(workspace.id)),
      ];
      return {
        ...current,
        workspaces,
        defaultWorkspaceId:
          current.defaultWorkspaceId ?? local.defaultWorkspaceId ?? workspaces[0]?.id ?? null,
      };
    });
  }
  applyView();
  void flush();
}

export function setRegistryWriter(writer: RegistryWriter | null): void {
  registryWriter = writer;
  if (writer) void flush();
}

export function setActiveReplacedListener(listener: ((layout: PaneLayout) => void) | null): void {
  onActiveReplaced = listener;
}

/** Adds an empty workspace and switches to it. */
export function createWorkspace(name?: string): PaneLayout | null {
  const id = randomUUID();
  commit((registry) => ({
    ...registry,
    workspaces: [
      ...registry.workspaces,
      {
        id,
        name:
          name?.trim() || nextWorkspaceName(registry.workspaces.map((workspace) => workspace.name)),
      },
    ],
  }));
  return switchWorkspace(id);
}

/** Makes `id` the workspace that holds threads without a workspace tag. */
export function setDefaultWorkspace(id: string): void {
  commit((registry) =>
    registry.workspaces.some((workspace) => workspace.id === id)
      ? { ...registry, defaultWorkspaceId: id }
      : registry,
  );
}

/** Sets (or with null clears) a workspace's picture. */
export function setWorkspaceIcon(id: string, icon: WorkspaceIcon | null): void {
  commit((registry) => ({
    ...registry,
    workspaces: registry.workspaces.map((workspace) => {
      if (workspace.id !== id) return workspace;
      const { icon: _previous, ...rest } = workspace;
      return icon ? { ...rest, icon } : rest;
    }),
  }));
}

/** Moves a workspace in the list so it sits before `beforeId` (or last when null). */
export function moveWorkspace(id: string, beforeId: string | null): void {
  if (id === beforeId) return;
  commit((registry) => ({
    ...registry,
    workspaces: reorderWorkspaces(registry.workspaces, id, beforeId),
  }));
}

export function renameWorkspace(id: string, name: string): void {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return;
  commit((registry) => ({
    ...registry,
    workspaces: registry.workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, name: trimmed } : workspace,
    ),
  }));
}

/**
 * Deletes a workspace (never the last one, nor one open in another window). Its threads
 * fall back to the default workspace: their tags are removed, and until then the unknown
 * id already reads as the default. Deleting the active one switches to a neighbour first;
 * its layout is returned like switchWorkspace.
 */
export function deleteWorkspace(id: string): PaneLayout | null | false {
  const view = viewRegistry();
  if (view.workspaces.length <= 1 || busyIdsFor(token).includes(id)) return false;
  let switched: PaneLayout | null = null;
  if (id === useWorkspacesStore.getState().activeId) {
    const busy = new Set(busyIdsFor(token));
    const index = view.workspaces.findIndex((workspace) => workspace.id === id);
    const others = view.workspaces.filter((workspace) => workspace.id !== id);
    const neighbour =
      others.slice(Math.max(0, index - 1)).find((workspace) => !busy.has(workspace.id)) ??
      others.find((workspace) => !busy.has(workspace.id));
    if (!neighbour) return false;
    switched = switchWorkspace(neighbour.id);
  }
  commit((registry) => {
    const workspaces = registry.workspaces.filter((workspace) => workspace.id !== id);
    return {
      ...registry,
      workspaces,
      defaultWorkspaceId:
        registry.defaultWorkspaceId === id
          ? (workspaces[0]?.id ?? null)
          : registry.defaultWorkspaceId,
    };
  });
  queueUntag(id);
  return switched;
}

// New threads are tagged with the workspace they were started in, once they exist on the
// server (a draft has no server thread yet).

interface PendingTag {
  readonly workspaceId: string;
  readonly at: number;
}

let membershipListener: (() => void) | null = null;

function notifyMembershipWork(): void {
  membershipListener?.();
}

/** The sync component re-checks pending tags when this fires. */
export function setMembershipListener(listener: (() => void) | null): void {
  membershipListener = listener;
}

function readPendingTags(): Record<string, PendingTag> {
  const raw = readJson(localStorage, PENDING_TAGS_KEY);
  return typeof raw === "object" && raw !== null ? (raw as Record<string, PendingTag>) : {};
}

function recordDraftTabs(keys: readonly string[]): void {
  const { activeId, defaultId } = useWorkspacesStore.getState();
  // Untagged threads already belong to the default workspace.
  if (keys.length === 0 || !activeId || activeId === defaultId) return;
  const pendingTags = readPendingTags();
  const now = Date.now();
  for (const key of keys) pendingTags[key] = { workspaceId: activeId, at: now };
  writeJson(localStorage, PENDING_TAGS_KEY, pendingTags);
  notifyMembershipWork();
}

/** Pending tags still worth writing (workspace exists, not expired), by thread key. */
export function pendingWorkspaceTags(): ReadonlyMap<string, string> {
  const pendingTags = readPendingTags();
  const known = new Set(viewRegistry().workspaces.map((workspace) => workspace.id));
  const now = Date.now();
  const live = new Map<string, string>();
  let pruned = false;
  for (const [key, entry] of Object.entries(pendingTags)) {
    if (!known.has(entry.workspaceId) || now - entry.at > PENDING_TAG_TTL_MS) {
      delete pendingTags[key];
      pruned = true;
    } else {
      live.set(key, entry.workspaceId);
    }
  }
  if (pruned) writeJson(localStorage, PENDING_TAGS_KEY, pendingTags);
  return live;
}

export function resolvePendingWorkspaceTag(threadKey: string): void {
  const pendingTags = readPendingTags();
  if (!(threadKey in pendingTags)) return;
  delete pendingTags[threadKey];
  writeJson(localStorage, PENDING_TAGS_KEY, pendingTags);
}

function queueUntag(workspaceId: string): void {
  const raw = readJson(localStorage, PENDING_UNTAG_KEY);
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  if (!ids.includes(workspaceId)) ids.push(workspaceId);
  writeJson(localStorage, PENDING_UNTAG_KEY, ids);
  notifyMembershipWork();
}

/** Deleted workspaces whose thread tags still need removing. */
export function pendingUntagWorkspaceIds(): readonly string[] {
  const raw = readJson(localStorage, PENDING_UNTAG_KEY);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

export function resolveUntag(workspaceId: string): void {
  writeJson(
    localStorage,
    PENDING_UNTAG_KEY,
    pendingUntagWorkspaceIds().filter((id) => id !== workspaceId),
  );
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

let threadTagWriter: ThreadTagWriter | null = null;
let threadTagReader: ((threadKey: string) => ReadonlyArray<string> | undefined) | null = null;

/** Registered by the sync component, which owns the server connection. */
export function setThreadTagAccess(
  writer: ThreadTagWriter | null,
  reader: ((threadKey: string) => ReadonlyArray<string> | undefined) | null,
): void {
  threadTagWriter = writer;
  threadTagReader = reader;
}

/** Makes `targetId` the thread's only workspace. Resolves false if a tag write failed. */
export async function moveThreadToWorkspace(
  threadRef: ScopedThreadRef,
  targetId: string,
): Promise<boolean> {
  if (threadTagWriter === null || threadTagReader === null) return false;
  const key = scopedThreadKey(threadRef);
  resolvePendingWorkspaceTag(key);
  const tags = threadTagReader(key) ?? [];
  const { defaultId } = useWorkspacesStore.getState();
  for (const change of moveThreadTagChanges(tags, targetId, defaultId)) {
    if (!(await threadTagWriter(threadRef, change.tag, change.tagged))) return false;
  }
  return true;
}

/**
 * The "Move to workspace" choices for a root thread (a subagent follows its root, so it
 * gets none), with its current workspaces checked.
 */
export function workspaceMenuTargets(
  threadRef: ScopedThreadRef,
  isRootThread: boolean,
):
  | ReadonlyArray<{ readonly id: string; readonly label: string; readonly checked: boolean }>
  | undefined {
  const { registryReady, workspaces, defaultId, busyIds } = useWorkspacesStore.getState();
  if (!isRootThread || !registryReady || threadTagReader === null) return undefined;
  const tags = threadTagReader(scopedThreadKey(threadRef)) ?? [];
  const current = threadWorkspaceIds(scopedThreadKey(threadRef), null, {
    knownIds: new Set(workspaces.map((workspace) => workspace.id)),
    defaultId,
    tagsByKey: new Map([[scopedThreadKey(threadRef), tags]]),
  });
  return workspaces.map((workspace) => ({
    id: workspace.id,
    // oxlint-disable-next-line t3code/no-untranslated-copy -- fork copy, English-only
    label: busyIds.includes(workspace.id) ? `${workspace.name} (other window)` : workspace.name,
    checked: current.includes(workspace.id),
  }));
}

/** The thread menu's workspace part, spread into its state (nothing for a subagent). */
export function forkWorkspaceMenuState(
  threadRef: ScopedThreadRef,
  thread: { readonly id: string; readonly lineage?: { readonly rootThreadId: string } | null },
): { readonly workspaceTargets?: NonNullable<ReturnType<typeof workspaceMenuTargets>> } {
  const isRoot = !thread.lineage || thread.lineage.rootThreadId === thread.id;
  const targets = workspaceMenuTargets(threadRef, isRoot);
  return targets ? { workspaceTargets: targets } : {};
}
