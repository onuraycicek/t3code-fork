import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { useForkPrefsStore } from "./forkPrefsStore";
import { moveProjectKey, projectDropIndex } from "./sidebarProjectGroups.logic";

const HEADER_TESTID = "sidebar-project-header";
const DRAG_THRESHOLD_PX = 5;
// A project's group ends at the next header or at the first section marker.
const GROUP_END_TESTID = /^sidebar-(project-header|(pinned|active|working|snoozed|settled)-)/;

type DropGeometry = {
  readonly keys: readonly string[];
  readonly groups: readonly { top: number; bottom: number }[];
};

function groupGeometry(source: HTMLElement): DropGeometry {
  const list = source.parentElement;
  const keys: string[] = [];
  const groups: { top: number; bottom: number }[] = [];
  if (list === null) return { keys, groups };
  for (const child of Array.from(list.children)) {
    if (!(child instanceof HTMLElement) || child.dataset.testid !== HEADER_TESTID) continue;
    const top = child.getBoundingClientRect().top;
    let bottom = child.getBoundingClientRect().bottom;
    for (
      let next = child.nextElementSibling;
      next instanceof HTMLElement && !GROUP_END_TESTID.test(next.dataset.testid ?? "");
      next = next.nextElementSibling
    ) {
      bottom = next.getBoundingClientRect().bottom;
    }
    keys.push(child.dataset.projectKey ?? "");
    groups.push({ top, bottom });
  }
  return { keys, groups };
}

export type ProjectHeaderDrag = {
  readonly dragging: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** True right after a drag ended, so the click that follows can be ignored. */
  readonly consumeClick: () => boolean;
  readonly overlay: React.ReactNode;
};

/**
 * Pointer-based drag of a project header. Moves the whole group: a line marks
 * the insertion point, release saves the order, Escape cancels. Independent of
 * the thread rows' dnd-kit sortable, so row drag-and-drop is untouched.
 */
export function useProjectHeaderDrag(input: {
  projectKey: string;
  label: string;
  sourceRef: React.RefObject<HTMLElement | null>;
}): ProjectHeaderDrag {
  const { projectKey, label, sourceRef } = input;
  const [session, setSession] = useState<{
    x: number;
    y: number;
    line: { top: number; left: number; width: number } | null;
  } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const source = sourceRef.current;
    if (event.button !== 0 || source === null) return;
    startRef.current = { x: event.clientX, y: event.clientY };
    let active = false;
    let geometry: DropGeometry = { keys: [], groups: [] };
    let target = -1;

    const finish = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      cleanupRef.current = null;
      startRef.current = null;
      setSession(null);
    };
    const onMove = (move: PointerEvent) => {
      const start = startRef.current;
      if (start === null) return;
      if (!active) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_THRESHOLD_PX) return;
        active = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      geometry = groupGeometry(source);
      const from = geometry.keys.indexOf(projectKey);
      const index = projectDropIndex(geometry.groups, move.clientY);
      // Dropping next to itself changes nothing: show no line.
      const noop = index === from || index === from + 1;
      target = noop ? -1 : index;
      const rect = source.getBoundingClientRect();
      const lineTop =
        index >= geometry.groups.length
          ? (geometry.groups.at(-1)?.bottom ?? rect.bottom)
          : geometry.groups[index]!.top;
      setSession({
        x: move.clientX,
        y: move.clientY,
        line: noop ? null : { top: lineTop, left: rect.left, width: rect.width },
      });
    };
    const onUp = () => {
      if (active) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        const from = geometry.keys.indexOf(projectKey);
        if (target !== -1 && from !== -1) {
          const store = useForkPrefsStore.getState();
          const toIndex = target > from ? target - 1 : target;
          const next = moveProjectKey(
            store.sidebarProjectOrder,
            geometry.keys,
            projectKey,
            toIndex,
          );
          if (next !== store.sidebarProjectOrder) store.setSidebarProjectOrder(next);
        }
      }
      finish();
    };
    const onCancel = () => finish();
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !active) return;
      key.preventDefault();
      key.stopPropagation();
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      finish();
    };
    cleanupRef.current = finish;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
  };

  const consumeClick = () => {
    const value = suppressClickRef.current;
    suppressClickRef.current = false;
    return value;
  };

  const overlay =
    session === null
      ? null
      : createPortal(
          <>
            {session.line ? (
              <div
                aria-hidden
                className="pointer-events-none fixed z-[1000] h-0.5 rounded-full bg-primary"
                style={{
                  top: session.line.top - 1,
                  left: session.line.left,
                  width: session.line.width,
                }}
              />
            ) : null}
            <div
              aria-hidden
              className="pointer-events-none fixed z-[1001] max-w-56 truncate rounded-md border border-border bg-popover px-2 py-1 text-sm font-medium text-popover-foreground shadow-md"
              style={{ top: session.y + 8, left: session.x + 12 }}
            >
              {label}
            </div>
          </>,
          document.body,
        );

  return { dragging: session !== null, onPointerDown, consumeClick, overlay };
}
