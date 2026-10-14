import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ReactNode } from "react";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
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
  const handleNewThread = useNewThreadHandler();
  if (item.kind === "project-header") {
    return (
      <SortableSidebarProjectItem item={item}>
        <div className="group/project-header relative mx-0.5 rounded-md hover:bg-sidebar-row-hover focus-within:bg-sidebar-row-hover">
          <button
            type="button"
            aria-label={`${project?.displayName ?? "Other"} project`}
            aria-expanded={item.expanded}
            data-thread-selection-safe
            disabled={project === null}
            onClick={() => props.onToggle(item.projectKey)}
            className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md pr-9 pl-1.5 text-left text-sm font-medium text-sidebar-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-default"
          >
            {project ? (
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-150",
                  item.expanded && "rotate-90",
                )}
              />
            ) : (
              <span aria-hidden className="size-3.5 shrink-0" />
            )}
            {project ? (
              <ProjectFavicon project={project} className="size-4 shrink-0" />
            ) : (
              <FolderIcon aria-hidden className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{project?.displayName ?? "Other"}</span>
            {item.expanded ? null : (
              <span className="shrink-0 text-xs font-normal tabular-nums text-sidebar-muted-foreground/70 group-hover/project-header:opacity-0">
                {item.threadCount}
              </span>
            )}
          </button>
          {project ? (
            <button
              type="button"
              aria-label={`New thread in ${project.displayName}`}
              data-thread-selection-safe
              onClick={() => {
                void handleNewThread(scopeProjectRef(project.environmentId, project.id));
              }}
              className="absolute top-1 right-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 group-hover/project-header:opacity-100"
            >
              <PlusIcon aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
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
        className="mx-0.5 flex h-8 w-[calc(100%-0.25rem)] cursor-pointer items-center gap-2 rounded-md pr-2 pl-5 text-left text-sm text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <PlusIcon className="size-3.5" />
        </span>
        Show {item.hiddenCount} more
      </button>
    </SortableSidebarProjectItem>
  );
}
