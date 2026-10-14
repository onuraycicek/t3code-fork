import { useMemo } from "react";

import { collectLeaves, type ChatPaneId, type ChatPaneNode } from "./chatPanes.logic";

/**
 * Softly highlights, in the sidebar, every thread that is on screen in a split
 * pane other than the focused one (the focused thread already gets the
 * sidebar's own active style). Done with a generated stylesheet keyed on the
 * rows' `data-thread-item` attribute so upstream sidebar code stays untouched.
 */
export function SidebarVisibleThreads({
  root,
  focusedPaneId,
}: {
  root: ChatPaneNode;
  focusedPaneId: ChatPaneId | null;
}) {
  const css = useMemo(() => {
    const keys = collectLeaves(root)
      .filter((leaf) => leaf.id !== focusedPaneId && leaf.activeKey !== null)
      .map((leaf) => leaf.activeKey as string);
    if (keys.length === 0) return "";
    const selector = [...new Set(keys)]
      .map((key) => `[data-thread-item="${CSS.escape(key)}"] [data-testid="sidebar-row-card"]`)
      .join(",\n");
    return `${selector} {\n  background-color: color-mix(in srgb, var(--foreground) 6%, transparent);\n}`;
  }, [root, focusedPaneId]);

  if (!css) return null;
  return <style data-fork-sidebar-visible-threads="">{css}</style>;
}
