import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, FolderIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { animateSidebarLayoutChanges, sidebarListItemId } from "../components/Sidebar.logic";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { cn } from "../lib/utils";
import type { SidebarProjectListItem } from "./sidebarProjectItems";

// Project headers and their "Show more" rows are list items too, so they shift
// with the rows during a drag. They are never picked up and never a drop target.
function SortableSidebarProjectItem(props: { item: SidebarProjectListItem; children: ReactNode }) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarListItemId(props.item),
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={`sidebar-${props.item.kind}`}
      className="list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

/** One project header or "Show more" row of the grouped active section. */
export function SidebarProjectGroupRow(props: {
  item: SidebarProjectListItem;
  project: SidebarProjectSnapshot | null;
  onToggle: (projectKey: string) => void;
  onShowMore: (projectKey: string) => void;
}) {
  const { item, project } = props;
  if (item.kind === "project-header") {
    return (
      <SortableSidebarProjectItem item={item}>
        <button
          type="button"
          aria-label={`${project?.displayName ?? "Other"} project`}
          aria-expanded={item.expanded}
          data-thread-selection-safe
          disabled={project === null}
          onClick={() => props.onToggle(item.projectKey)}
          className="group/project-header mx-0.5 flex h-8 w-[calc(100%-0.25rem)] cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground/85 hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-default"
        >
          {project ? (
            <ProjectFavicon project={project} className="size-4 shrink-0" />
          ) : (
            <FolderIcon aria-hidden className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{project?.displayName ?? "Other"}</span>
          {item.expanded ? null : (
            <span className="shrink-0 text-xs font-normal tabular-nums text-sidebar-muted-foreground/70">
              {item.threadCount}
            </span>
          )}
          {project ? (
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-muted-foreground transition-transform duration-150",
                !item.expanded && "-rotate-90",
              )}
            />
          ) : null}
        </button>
      </SortableSidebarProjectItem>
    );
  }
  return (
    <SortableSidebarProjectItem item={item}>
      <button
        type="button"
        aria-label={`Show ${item.hiddenCount} more threads in ${
          project?.displayName ?? "this project"
        }`}
        data-thread-selection-safe
        onClick={() => props.onShowMore(item.projectKey)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <PlusIcon aria-hidden className="size-4 shrink-0" />
        Show {item.hiddenCount} more
      </button>
    </SortableSidebarProjectItem>
  );
}
