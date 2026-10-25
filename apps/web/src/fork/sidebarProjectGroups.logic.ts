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
 * Groups follow `projectOrder`, then unknown projects. Expanded groups show the
 * first page unless listed in `showAllProjectKeys`. The open thread always stays
 * visible, appended after the page when it falls beyond it.
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
 * Manual project order: the saved order first, then projects it does not know
 * yet, appended in the given (current) order. Saved keys that are not present
 * right now (filtered out, still loading) keep their place so they come back
 * where the user left them.
 */
export function mergeProjectOrder(
  saved: readonly string[],
  current: readonly string[],
): readonly string[] {
  const known = new Set(saved);
  const added = current.filter((key) => !known.has(key));
  return added.length === 0 ? saved : [...saved, ...added];
}

/**
 * Move `key` so it sits at `toIndex` among the visible keys (counted without
 * `key` itself). Keys that are not visible keep their relative slots: the
 * visible keys are re-laid into the slots the visible keys already occupy.
 * Returns the order unchanged when the move is a no-op.
 */
export function moveProjectKey(
  order: readonly string[],
  visible: readonly string[],
  key: string,
  toIndex: number,
): readonly string[] {
  const full = mergeProjectOrder(order, visible);
  const visibleSet = new Set(visible);
  const rest = visible.filter((candidate) => candidate !== key);
  const clamped = Math.max(0, Math.min(toIndex, rest.length));
  const next = [...rest.slice(0, clamped), key, ...rest.slice(clamped)];
  let cursor = 0;
  const result = full.map((entry) => (visibleSet.has(entry) ? next[cursor++]! : entry));
  return result.every((entry, index) => entry === full[index]) && full === order ? order : result;
}

/**
 * Where a dragged project header lands: the index of the first group whose
 * vertical midpoint lies below the pointer (groups.length = after the last).
 */
export function projectDropIndex(
  groups: readonly { readonly top: number; readonly bottom: number }[],
  pointerY: number,
): number {
  const index = groups.findIndex((group) => pointerY < (group.top + group.bottom) / 2);
  return index === -1 ? groups.length : index;
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
