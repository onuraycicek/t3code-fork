import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { CommandPaletteContent } from "../components/CommandPaletteContent";
import type { CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { CommandPaletteResults } from "../components/CommandPaletteResults";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { CommandDialog, CommandDialogPopup } from "../components/ui/command";
import { toastManager } from "../components/ui/toast";
import { revealThreadTerminal } from "../lib/revealThreadTerminal";
import { normalizeSearchText } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useProjects, useThreadShells } from "../state/entities";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useTerminalMoveStore, type TerminalMoveRequest } from "./terminalMoveStore";

const RESULT_LIMIT = 50;

/**
 * Fork: "Move to chat" picker. Lists the other chats of the terminal's
 * environment, newest first. Picking one hands the live session to that chat
 * (the process keeps running), then opens the chat with the terminal shown.
 * Mounted once per window by ChatPanes; terminals open it through
 * `requestTerminalMove`.
 */
export function MoveTerminalDialog() {
  const request = useTerminalMoveStore((state) => state.request);
  const close = useTerminalMoveStore((state) => state.close);
  return (
    <CommandDialog open={request !== null} onOpenChange={(open) => !open && close()}>
      {request ? <MoveTerminalPicker request={request} onClose={close} /> : null}
    </CommandDialog>
  );
}

function MoveTerminalPicker({
  request,
  onClose,
}: {
  request: TerminalMoveRequest;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const moveTerminal = useAtomCommand(terminalEnvironment.move, "terminal move");
  const threads = useThreadShells();
  const projects = useProjects();
  const { environmentId, threadId } = request.threadRef;

  const projectsById = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project]),
  );
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.id !== threadId &&
        thread.deletedAt == null &&
        thread.archivedAt == null &&
        thread.lineage.relationshipToParent !== "subagent",
    )
    .filter((thread) => {
      if (tokens.length === 0) return true;
      const haystack = normalizeSearchText(
        `${thread.title} ${projectsById.get(thread.projectId)?.title ?? ""}`,
      );
      return tokens.every((token) => haystack.includes(token));
    })
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RESULT_LIMIT);

  const moveTo = async (targetThreadId: (typeof candidates)[number]["id"], title: string) => {
    onClose();
    const result = await moveTerminal({
      environmentId,
      input: { threadId, terminalId: request.terminalId, targetThreadId },
    });
    if (result._tag !== "Success") return;
    const targetRef = scopeThreadRef(environmentId, targetThreadId);
    revealThreadTerminal(targetRef, result.value.terminalId);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) });
    toastManager.add({ type: "success", title: `Moved ${request.label} to ${title}` });
  };

  const items: CommandPaletteActionItem[] = candidates.map((thread) => {
    const project = projectsById.get(thread.projectId);
    return {
      kind: "action",
      value: `move-terminal:${thread.id}`,
      searchTerms: [thread.title, project?.title ?? ""],
      title: thread.title,
      ...(project ? { description: project.title } : {}),
      icon: project ? (
        <ProjectFavicon project={project} className="size-4" />
      ) : (
        <MessageSquareIcon />
      ),
      run: () => moveTo(thread.id, thread.title),
    };
  });

  return (
    <CommandDialogPopup
      aria-label={`Move ${request.label} to chat`}
      className="overflow-hidden"
      onBackdropPointerDown={onClose}
    >
      <CommandPaletteContent
        aria-label={`Move ${request.label} to chat`}
        autoHighlight="always"
        escapeLabel="Close"
        footerActionLabel="Move here"
        inputProps={{ placeholder: `Move ${request.label} to chat…` }}
        mode="none"
        onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
        onValueChange={(value) => {
          setHighlighted(null);
          setQuery(value);
        }}
        panelSize="tall-list"
        testId="move-terminal-picker"
        value={query}
      >
        <CommandPaletteResults
          groups={items.length > 0 ? [{ value: "move-terminal-chats", label: "Chats", items }] : []}
          highlightedItemValue={highlighted}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={(item) => {
            if (item.kind !== "action") return;
            void item.run();
          }}
          emptyStateMessage={query.trim() ? "No matching chats." : "No other chats."}
        />
      </CommandPaletteContent>
    </CommandDialogPopup>
  );
}
