import type { OrchestrationV2TurnItem, RunId, ScopedThreadRef } from "@t3tools/contracts";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowRightLeftIcon, ScanSearchIcon } from "lucide-react";
import { useState } from "react";

import { ModelPickerContent } from "../components/chat/ModelPickerContent";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useEnvironmentProviders } from "../state/environments";
import { useThreadProjection, useThreadShell } from "../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { buildResponseHandoffPrompt, type ResponseHandoffKind } from "./responseHandoff.logic";

const ACTIONS: Record<
  ResponseHandoffKind,
  { readonly label: string; readonly Icon: typeof ArrowRightLeftIcon }
> = {
  handoff: { label: "Hand off to another agent", Icon: ArrowRightLeftIcon },
  "second-opinion": { label: "Second opinion from another agent", Icon: ScanSearchIcon },
};

/**
 * "Hand off" and "Second opinion" buttons for a completed assistant response. Each one asks for
 * a model and opens a new draft thread in the same project and workspace, with a prompt that
 * carries the request, the response and the files that run changed. Nothing is sent: the user
 * reads the draft and presses Send.
 */
export function ResponseHandoffActions(props: {
  /** The projected turn item behind the message; only completed assistant messages qualify. */
  readonly item: OrchestrationV2TurnItem | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly text: string;
}) {
  const { item, threadRef } = props;
  if (
    threadRef === null ||
    item?.type !== "assistant_message" ||
    item.status !== "completed" ||
    item.runId === null ||
    props.text.trim().length === 0
  ) {
    return null;
  }
  const shared = { threadRef, runId: item.runId, responseText: props.text };
  return (
    <>
      <ResponseHandoffButton kind="handoff" {...shared} />
      <ResponseHandoffButton kind="second-opinion" {...shared} />
    </>
  );
}

function ResponseHandoffButton(props: {
  readonly kind: ResponseHandoffKind;
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId | null;
  readonly responseText: string;
}) {
  const [open, setOpen] = useState(false);
  const { label, Icon } = ACTIONS[props.kind];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button type="button" size="xs" variant="ghost" aria-label={label}>
                  <Icon className={cn("size-3")} />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="before:hidden" padding="none">
        {open ? <ResponseHandoffPicker {...props} onClose={() => setOpen(false)} /> : null}
      </PopoverPopup>
    </Popover>
  );
}

/** Mounted only while the popover is open, so idle messages do not derive model catalogs. */
function ResponseHandoffPicker(props: {
  readonly kind: ResponseHandoffKind;
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId | null;
  readonly responseText: string;
  readonly onClose: () => void;
}) {
  const { threadRef, kind } = props;
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const handleNewThread = useNewThreadHandler();
  const providers = providersByEnvironment.get(threadRef.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const current: ModelSelection | null = shell?.modelSelection ?? null;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      shell?.projectId ?? null,
    ),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    current?.instanceId,
    current?.model,
  );
  const firstEntry = entries[0];
  const activeInstanceId: ProviderInstanceId | undefined =
    current?.instanceId ?? firstEntry?.instanceId;
  if (shell === null || activeInstanceId === undefined) {
    return <div className="p-3 text-muted-foreground text-xs">Thread data is not loaded yet.</div>;
  }

  const open = async (instanceId: ProviderInstanceId, model: string) => {
    props.onClose();
    const opened = await handleNewThread(
      scopeProjectRef(threadRef.environmentId, shell.projectId),
      {
        branch: shell.branch,
        worktreePath: shell.worktreePath,
        envMode: shell.worktreePath ? "worktree" : "local",
        startFromOrigin: false,
      },
    ).catch(() => null);
    if (opened === null) {
      toastManager.add(stackedThreadToast({ type: "error", title: "Could not open a new thread" }));
      return;
    }
    const sourceEntry = entries.find((entry) => entry.instanceId === current?.instanceId);
    const request =
      projection?.messages.findLast(
        (message) => message.role === "user" && message.runId === props.runId,
      )?.text ?? null;
    const changedFiles =
      projection?.checkpoints
        .filter((checkpoint) => checkpoint.runId === props.runId)
        .flatMap((checkpoint) => checkpoint.files) ?? [];
    const prompt = buildResponseHandoffPrompt({
      kind,
      threadTitle: shell.title,
      sourceLabel:
        sourceEntry === undefined || current === null
          ? null
          : `${sourceEntry.displayName} (${current.model})`,
      request,
      response: props.responseText,
      changedFiles,
    });
    const store = useComposerDraftStore.getState();
    store.setModelSelection(opened.draftId, createModelSelection(instanceId, model), {
      explicit: true,
      replaceOptions: true,
    });
    // A review must not change the workspace, so every edit waits for approval.
    if (kind === "second-opinion") store.setRuntimeMode(opened.draftId, "approval-required");
    store.setPrompt(opened.draftId, prompt);
  };

  return (
    <ModelPickerContent
      environmentId={threadRef.environmentId}
      activeInstanceId={activeInstanceId}
      model={current?.model ?? ""}
      lockedProvider={null}
      lockedContinuationGroupKey={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      terminalOpen={false}
      onRequestClose={props.onClose}
      onInstanceModelChange={(instanceId, model) => void open(instanceId, model)}
    />
  );
}
