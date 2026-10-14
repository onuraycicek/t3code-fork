import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useMemo, useState } from "react";

import type { SidebarListItem, SidebarSection } from "../components/Sidebar.logic";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useForkPrefsStore } from "./forkPrefsStore";
import {
  buildSidebarProjectGroupItems,
  buildSidebarProjectThreadGroups,
} from "./sidebarProjectGroups.logic";

type GroupableThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId">;

const threadKeyOf = (thread: GroupableThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

// Same keys as the legacy sidebar, so a project collapsed in one stays
// collapsed in the other.
function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

/**
 * Project grouping of the sidebar's active section. A single-project filter
 * leaves one group, so the headers would only repeat the filter: grouping is
 * skipped then (`projectFilterActive`).
 */
export function useSidebarProjectGrouping<TThread extends GroupableThread>(input: {
  readonly activeThreads: readonly TThread[];
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly projectGroupByScopeKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly projectFilterActive: boolean;
  readonly routeThreadKey: string | null;
}) {
  const { activeThreads, projectGroups, projectGroupByScopeKey, routeThreadKey } = input;
  const enabled = useForkPrefsStore((state) => state.sidebarProjectGroupingEnabled);
  const active = enabled && !input.projectFilterActive;
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  // Projects whose "Show more" was pressed; they list every active thread.
  const [showAllProjectKeys, setShowAllProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const projectKeyByPhysicalRef = useMemo(
    () =>
      new Map<string, string>(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (member) => [`${member.environmentId}:${member.id}`, group.projectKey] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  const projectKeyOfThread = useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) => {
      const physicalKey = `${thread.environmentId}:${thread.projectId}`;
      return projectKeyByPhysicalRef.get(physicalKey) ?? `project:${physicalKey}`;
    },
    [projectKeyByPhysicalRef],
  );
  const groups = useMemo(
    () =>
      active
        ? buildSidebarProjectThreadGroups({
            threads: activeThreads,
            projectKeyOf: projectKeyOfThread,
            threadKeyOf,
            projectOrder: projectGroups.map((group) => group.projectKey),
            isExpanded: (projectKey) => {
              const project = projectGroupByScopeKey.get(projectKey);
              return (
                project === undefined ||
                resolveProjectExpanded(projectExpandedById, projectExpansionPreferenceKeys(project))
              );
            },
            showAllProjectKeys,
            routeThreadKey,
          })
        : null,
    [
      active,
      activeThreads,
      projectExpandedById,
      projectGroupByScopeKey,
      projectGroups,
      projectKeyOfThread,
      routeThreadKey,
      showAllProjectKeys,
    ],
  );
  const visibleActiveThreads = useMemo(
    () => (groups === null ? activeThreads : groups.flatMap((group) => group.visibleThreads)),
    [activeThreads, groups],
  );
  /** Extra fields for a thread list item: its project, while grouped. */
  const threadItemProps = useCallback(
    (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
      groups === null ? {} : { projectKey: projectKeyOfThread(thread) },
    [groups, projectKeyOfThread],
  );
  /** The active section's items: `rows` as is, or headers + visible rows + "Show more". */
  const activeItems = useCallback(
    (rows: readonly SidebarListItem[]): readonly SidebarListItem[] =>
      groups === null ? rows : buildSidebarProjectGroupItems(groups, rows, threadKeyOf),
    [groups],
  );
  const toggleProject = useCallback(
    (projectKey: string) => {
      const project = projectGroupByScopeKey.get(projectKey);
      if (project === undefined) return;
      if (useThreadSelectionStore.getState().hasSelection()) clearSelection();
      const keys = projectExpansionPreferenceKeys(project);
      setProjectExpanded(keys, !resolveProjectExpanded(projectExpandedById, keys));
    },
    [clearSelection, projectExpandedById, projectGroupByScopeKey, setProjectExpanded],
  );
  const showMore = useCallback((projectKey: string) => {
    setShowAllProjectKeys((current) =>
      current.has(projectKey) ? current : new Set(current).add(projectKey),
    );
  }, []);
  return {
    activeItems,
    /** Grouped rows sit under their project header, so the card drops its own label. */
    hidesProjectLabel: (section: SidebarSection) => groups !== null && section === "active",
    projectOf: (projectKey: string) => projectGroupByScopeKey.get(projectKey) ?? null,
    showMore,
    threadItemProps,
    toggleProject,
    visibleActiveThreads,
  };
}
