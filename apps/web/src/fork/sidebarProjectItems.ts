import type { SidebarListItem } from "../components/Sidebar.logic";

/**
 * Extra sidebar list item kinds for the project-grouped active section.
 * Also holds the drop-order helper Sidebar.logic calls; this file has no runtime
 * imports from Sidebar.logic, so that file can import it without a cycle.
 */
export type SidebarProjectListItem =
  /** The collapsible header above one project's active rows. */
  | {
      readonly kind: "project-header";
      readonly projectKey: string;
      readonly expanded: boolean;
      /** Active threads the project holds, shown or not. */
      readonly threadCount: number;
      /** Every active key (shown or not) in canonical order, shared by all headers. */
      readonly canonicalActiveOrder: readonly string[];
    }
  /** The "Show more" row closing a project's rows. */
  | { readonly kind: "project-more"; readonly projectKey: string; readonly hiddenCount: number };

export function isSidebarProjectListItem(item: SidebarListItem): item is SidebarProjectListItem {
  return item.kind === "project-header" || item.kind === "project-more";
}

export function sidebarProjectListItemId(item: SidebarProjectListItem): string {
  // Colon-free prefix, like markers, so ids never collide with thread keys.
  return `sidebar-project-${item.kind}-${encodeURIComponent(item.projectKey)}`;
}

/**
 * Grouped mode: the visible list is project-major, so a drop's active order is
 * rebuilt from the canonical order (carried by the project headers), moving
 * only the dragged row. Without headers the upstream order is kept.
 */
export function withProjectGroupedActiveOrder<
  TTarget extends { readonly activeOrder: readonly string[] },
>(
  items: readonly SidebarListItem[],
  moved: readonly SidebarListItem[],
  index: number,
  activeKey: string,
  target: TTarget,
): TTarget {
  const header = items.find((item) => item.kind === "project-header");
  if (header?.kind !== "project-header") return target;
  return {
    ...target,
    activeOrder: placeInCanonicalOrder(moved, index, header.canonicalActiveOrder, activeKey),
  };
}

/** The canonical active order with the dragged row moved next to its project
 * neighbors in the previewed list. A row with no neighbor in its project
 * (it came from another section) goes first, where a fresh arrival sorts. */
function placeInCanonicalOrder(
  moved: readonly SidebarListItem[],
  index: number,
  canonical: readonly string[],
  activeKey: string,
): string[] {
  const dragged = moved[index];
  const order = canonical.filter((key) => key !== activeKey);
  if (dragged?.kind !== "thread" || dragged.projectKey === undefined) return order;
  const mateAt = (position: number) => {
    const item = moved[position];
    return item?.kind === "thread" &&
      item.section === "active" &&
      item.projectKey === dragged.projectKey
      ? item.key
      : null;
  };
  for (let position = index - 1; position >= 0; position -= 1) {
    const mate = mateAt(position);
    if (mate === null) continue;
    order.splice(order.indexOf(mate) + 1, 0, activeKey);
    return order;
  }
  for (let position = index + 1; position < moved.length; position += 1) {
    const mate = mateAt(position);
    if (mate === null) continue;
    order.splice(order.indexOf(mate), 0, activeKey);
    return order;
  }
  order.unshift(activeKey);
  return order;
}
