import type { SidebarListItem } from "../components/Sidebar.logic";
import { sidebarListItemId } from "../components/Sidebar.logic";

/** Active rows each project shows before "Show more". */
export const SIDEBAR_PROJECT_INITIAL_THREAD_COUNT = 5;

export type SidebarProjectThreadGroup<TThread> = {
  readonly projectKey: string;
  readonly expanded: boolean;
  /** Every active thread of the project, in the order given. */
  readonly threads: readonly TThread[];
  /** The rows to render: the first page, or all after "Show more". */
  readonly visibleThreads: readonly TThread[];
  readonly hiddenCount: number;
};

/**
 * Split the active section into per-project groups. Threads keep their given
 * order inside a group; groups follow `projectOrder`, then any project the
 * order does not know. A collapsed project shows no rows and an expanded one
 * shows the first page, unless `showAllProjectKeys` lists it. The open thread
 * always stays visible, appended after the page when it falls beyond it.
 */
export function buildSidebarProjectThreadGroups<TThread>(input: {
  readonly threads: readonly TThread[];
  readonly projectKeyOf: (thread: TThread) => string;
  readonly threadKeyOf: (thread: TThread) => string;
  readonly projectOrder: readonly string[];
  readonly isExpanded: (projectKey: string) => boolean;
  readonly showAllProjectKeys: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
  readonly initialCount?: number;
}): SidebarProjectThreadGroup<TThread>[] {
  const initialCount = input.initialCount ?? SIDEBAR_PROJECT_INITIAL_THREAD_COUNT;
  const byProject = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    const projectKey = input.projectKeyOf(thread);
    const existing = byProject.get(projectKey);
    if (existing) existing.push(thread);
    else byProject.set(projectKey, [thread]);
  }
  const orderedKeys = [
    ...input.projectOrder.filter((key) => byProject.has(key)),
    ...[...byProject.keys()].filter((key) => !input.projectOrder.includes(key)),
  ];
  return orderedKeys.map((projectKey) => {
    const threads = byProject.get(projectKey)!;
    const expanded = input.isExpanded(projectKey);
    const page = !expanded
      ? []
      : input.showAllProjectKeys.has(projectKey)
        ? threads
        : threads.slice(0, initialCount);
    const routeThread =
      input.routeThreadKey === null
        ? undefined
        : threads.find((thread) => input.threadKeyOf(thread) === input.routeThreadKey);
    const visibleThreads =
      routeThread !== undefined && !page.includes(routeThread) ? [...page, routeThread] : page;
    return {
      projectKey,
      expanded,
      threads,
      visibleThreads,
      hiddenCount: threads.length - visibleThreads.length,
    };
  });
}

/**
 * The list items of the grouped active section: per project a header, the
 * visible rows, and a "Show more" row. `rows` holds one thread item per active
 * thread (each carrying its projectKey), in canonical order.
 */
export function buildSidebarProjectGroupItems<TThread>(
  groups: readonly SidebarProjectThreadGroup<TThread>[],
  rows: readonly SidebarListItem[],
  threadKeyOf: (thread: TThread) => string,
): SidebarListItem[] {
  const rowByKey = new Map(
    rows.flatMap((row) => (row.kind === "thread" ? [[row.key, row] as const] : [])),
  );
  const canonicalActiveOrder = [...rowByKey.keys()];
  const items: SidebarListItem[] = [];
  for (const group of groups) {
    items.push({
      kind: "project-header",
      projectKey: group.projectKey,
      expanded: group.expanded,
      threadCount: group.threads.length,
      canonicalActiveOrder,
    });
    for (const thread of group.visibleThreads) {
      const row = rowByKey.get(threadKeyOf(thread));
      if (row) items.push(row);
    }
    if (group.expanded && group.hiddenCount > 0) {
      items.push({
        kind: "project-more",
        projectKey: group.projectKey,
        hiddenCount: group.hiddenCount,
      });
    }
  }
  return items;
}

/**
 * Drag preview: each project keeps its header and "Show more" row while the
 * previewed rows slot into their own project. A row arriving from another
 * section for a project with no header trails the active section.
 */
export function projectGroupedActiveRows(
  items: readonly SidebarListItem[],
  activeRows: readonly SidebarListItem[],
): readonly SidebarListItem[] {
  const headers = items.filter((item) => item.kind === "project-header");
  if (headers.length === 0) return activeRows;
  const rows: SidebarListItem[] = [];
  const placed = new Set<string>();
  const projectKeyOf = (item: SidebarListItem) => (item.kind === "thread" ? item.projectKey : null);
  for (const header of headers) {
    if (header.kind !== "project-header") continue;
    placed.add(header.projectKey);
    rows.push(header);
    rows.push(...activeRows.filter((item) => projectKeyOf(item) === header.projectKey));
    const more = items.find(
      (item) => item.kind === "project-more" && item.projectKey === header.projectKey,
    );
    if (more) rows.push(more);
  }
  rows.push(...activeRows.filter((item) => !placed.has(projectKeyOf(item) ?? "")));
  return rows;
}

/** Grouped mode: an active row can only be reordered inside its own project,
 * so project headers, "Show more" rows, and other projects' rows are not
 * drop targets for it. Pins, settling, and other sections are unaffected. */
export function isSidebarProjectDropAllowed(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): boolean {
  const source = items.find((item) => item.kind === "thread" && item.key === activeKey);
  if (source?.kind !== "thread" || source.section !== "active" || !source.projectKey) return true;
  const over = items.find((item) => sidebarListItemId(item) === overId);
  if (over === undefined) return true;
  if (over.kind === "thread") {
    return over.section !== "active" || over.projectKey === source.projectKey;
  }
  return over.kind === "marker";
}
