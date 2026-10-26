import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useState } from "react";

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
  mergeProjectOrder,
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
  const savedProjectOrder = useForkPrefsStore((state) => state.sidebarProjectOrder);
  const setSavedProjectOrder = useForkPrefsStore((state) => state.setSidebarProjectOrder);
  // Manual order: seeded once from the order shown at that moment, new
  // projects are appended at the bottom and saved so they stay put.
  const projectOrder = mergeProjectOrder(
    savedProjectOrder,
    projectGroups.map((group) => group.projectKey),
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- Persists the merged project order to localStorage once new projects appear.
  useEffect(() => {
    if (active && projectGroups.length > 0 && projectOrder !== savedProjectOrder) {
      setSavedProjectOrder(projectOrder);
    }
  }, [active, projectGroups.length, projectOrder, savedProjectOrder, setSavedProjectOrder]);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  // Projects whose "Show more" was pressed; they list every active thread.
  const [showAllProjectKeys, setShowAllProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const projectKeyByPhysicalRef = new Map<string, string>(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (member) => [`${member.environmentId}:${member.id}`, group.projectKey] as const,
      ),
    ),
  );
  const projectKeyOfThread = (
    thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  ) => {
    const physicalKey = `${thread.environmentId}:${thread.projectId}`;
    return projectKeyByPhysicalRef.get(physicalKey) ?? `project:${physicalKey}`;
  };
  const groups = active
    ? buildSidebarProjectThreadGroups({
        threads: activeThreads,
        projectKeyOf: projectKeyOfThread,
        threadKeyOf,
        projectOrder,
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
    : null;
  const visibleActiveThreads =
    groups === null ? activeThreads : groups.flatMap((group) => group.visibleThreads);
  /** Extra fields for a thread list item: its project, while grouped. */
  const threadItemProps = (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    groups === null ? {} : { projectKey: projectKeyOfThread(thread) };
  /** The active section's items: `rows` as is, or headers + visible rows + "Show more". */
  const activeItems = (rows: readonly SidebarListItem[]): readonly SidebarListItem[] =>
    groups === null ? rows : buildSidebarProjectGroupItems(groups, rows, threadKeyOf);
  const toggleProject = (projectKey: string) => {
    const project = projectGroupByScopeKey.get(projectKey);
    if (project === undefined) return;
    if (useThreadSelectionStore.getState().hasSelection()) clearSelection();
    const keys = projectExpansionPreferenceKeys(project);
    setProjectExpanded(keys, !resolveProjectExpanded(projectExpandedById, keys));
  };
  const showMore = (projectKey: string) => {
    setShowAllProjectKeys((current) =>
      current.has(projectKey) ? current : new Set(current).add(projectKey),
    );
  };
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
