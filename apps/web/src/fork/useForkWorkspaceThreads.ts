import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { isThreadInWorkspace, type WorkspaceMembershipContext } from "./workspaces.logic";
import { forkEnvironmentKey, forkThreadTagsAtom, type ForkThreadTags } from "./workspaceServer";
import { useWorkspacesStore } from "./workspacesStore";

export function membershipContext(
  workspaceIds: readonly string[],
  defaultId: string | null,
  threadTags: ReadonlyMap<string, ForkThreadTags>,
): WorkspaceMembershipContext {
  const tagsByKey = new Map<string, ReadonlyArray<string>>();
  for (const [key, entry] of threadTags) tagsByKey.set(key, entry.tags);
  return { knownIds: new Set(workspaceIds), defaultId, tagsByKey };
}

/** The scoped key of the root thread a subagent belongs to, or null for a root thread. */
export function rootThreadKey(thread: EnvironmentThreadShell): string | null {
  const rootThreadId = thread.lineage?.rootThreadId;
  return rootThreadId
    ? scopedThreadKey({ environmentId: thread.environmentId, threadId: rootThreadId })
    : null;
}

/**
 * Fork: the sidebar's threads narrowed to the active workspace: its members (by the
 * `workspace:<id>` tag, untagged ones in the default workspace) plus whatever is open as
 * a tab in it. Until the server registry arrives nothing is filtered, so an unloaded
 * registry never reads as an empty workspace.
 */
export function useForkWorkspaceThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const registryReady = useWorkspacesStore((state) => state.registryReady);
  const activeId = useWorkspacesStore((state) => state.activeId);
  const defaultId = useWorkspacesStore((state) => state.defaultId);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const environmentKey = forkEnvironmentKey(threads.map((thread) => thread.environmentId));
  const threadTags = useAtomValue(forkThreadTagsAtom(environmentKey));

  if (!registryReady || defaultId === null || !activeId) return threads;
  const context = membershipContext(
    workspaces.map((workspace) => workspace.id),
    defaultId,
    threadTags,
  );
  const openKeys = new Set(
    (workspaces.find((workspace) => workspace.id === activeId)?.tabs ?? []).map((tab) =>
      scopedThreadKey(tab),
    ),
  );
  const filtered = threads.filter((thread) => {
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    return openKeys.has(key) || isThreadInWorkspace(activeId, key, rootThreadKey(thread), context);
  });
  return filtered.length === threads.length ? threads : filtered;
}
