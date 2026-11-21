import { useAtomValue } from "@effect/atom-react";
import { CommandId, forkWorkspaceTag, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { useStableCallback } from "../hooks/useStableCallback";
import { useAtomCommand } from "../state/use-atom-command";
import { navigateToLayout, type RouteNavigate } from "./workspaceNavigation";
import {
  forkDispatchCommand,
  forkEnvironmentKey,
  forkThreadTagsAtom,
  forkWorkspaceRegistryFeed,
  forkWorkspacesUpdate,
} from "./workspaceServer";
import {
  pendingUntagWorkspaceIds,
  pendingWorkspaceTags,
  receiveServerRegistry,
  resolvePendingWorkspaceTag,
  resolveUntag,
  setActiveReplacedListener,
  setMembershipListener,
  setRegistryWriter,
  setThreadTagAccess,
  useWorkspacesStore,
  type RegistryValue,
  type ThreadTagWriter,
} from "./workspacesStore";

const NO_REGISTRY = Atom.make(AsyncResult.initial<RegistryValue>());
/** A failed tag write is tried again after this long. */
const TAG_RETRY_MS = 5_000;

/**
 * Fork: connects the workspace store to the primary environment's server. Streams the
 * registry in, sends registry changes out, and writes workspace tags: on threads started
 * in a workspace, and off threads of deleted workspaces. Renders nothing.
 */
export function WorkspaceServerSync() {
  const navigateRaw = useNavigate();
  const navigate: RouteNavigate = (options) => navigateRaw(options as never);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useAtomValue(
    primaryEnvironmentId === null
      ? NO_REGISTRY
      : forkWorkspaceRegistryFeed({ environmentId: primaryEnvironmentId, input: null }),
  );
  const updateRegistry = useAtomCommand(forkWorkspacesUpdate, { reportFailure: false });
  const dispatch = useAtomCommand(forkDispatchCommand, { reportFailure: false });
  const shells = useThreadShells();
  const environmentKey = forkEnvironmentKey(shells.map((shell) => shell.environmentId));
  const threadTags = useAtomValue(forkThreadTagsAtom(environmentKey));
  const registryReady = useWorkspacesStore((state) => state.registryReady);
  const [membershipTick, setMembershipTick] = useState(0);
  const inFlight = useRef(new Set<string>());

  const registryValue = AsyncResult.isSuccess(registry) ? registry.value : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pushes the streamed server registry into the external workspace store.
  useEffect(() => {
    if (registryValue) receiveServerRegistry(registryValue);
  }, [registryValue]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers the server writers the external store calls.
  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    const environmentId: EnvironmentId = primaryEnvironmentId;
    setRegistryWriter(async (input) => {
      const result = await updateRegistry({ environmentId, input: { ...input } });
      return result._tag === "Success" ? result.value : null;
    });
    return () => setRegistryWriter(null);
  }, [primaryEnvironmentId, updateRegistry]);

  const writeTag: ThreadTagWriter = useStableCallback(async (threadRef, tag, tagged) => {
    const result = await dispatch({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.tag.set",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        tag,
        tagged,
      },
    });
    return result._tag === "Success";
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Gives the external store read access to tags and a tag writer.
  useEffect(() => {
    setThreadTagAccess(writeTag, (key) => threadTags.get(key)?.tags);
    return () => setThreadTagAccess(null, null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follows the route when this window's workspace is deleted elsewhere.
  useEffect(() => {
    setActiveReplacedListener((layout) => navigateToLayout(layout, navigate));
    setMembershipListener(() => setMembershipTick((tick) => tick + 1));
    return () => {
      setActiveReplacedListener(null);
      setMembershipListener(null);
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Writes pending workspace tags to the server once their threads exist there.
  useEffect(() => {
    if (!registryReady) return;
    const retry = () => setTimeout(() => setMembershipTick((tick) => tick + 1), TAG_RETRY_MS);

    for (const [threadKey, workspaceId] of pendingWorkspaceTags()) {
      const thread = threadTags.get(threadKey);
      // Still a draft (or not loaded yet): wait for the server thread.
      if (!thread) continue;
      const tag = forkWorkspaceTag(workspaceId);
      if (thread.tags.includes(tag)) {
        resolvePendingWorkspaceTag(threadKey);
        continue;
      }
      const flightKey = `tag:${threadKey}`;
      if (inFlight.current.has(flightKey)) continue;
      inFlight.current.add(flightKey);
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- writeTag is a stable callback; membershipTick re-runs this check.
      void writeTag(thread.ref, tag, true).then((ok) => {
        inFlight.current.delete(flightKey);
        if (!ok) retry();
      });
    }

    // Removing a deleted workspace's tags needs the thread list; an empty one is not loaded.
    if (threadTags.size === 0) return;
    for (const workspaceId of pendingUntagWorkspaceIds()) {
      const tag = forkWorkspaceTag(workspaceId);
      const holders = [...threadTags.values()].filter((thread) => thread.tags.includes(tag));
      if (holders.length === 0) {
        resolveUntag(workspaceId);
        continue;
      }
      for (const thread of holders) {
        const flightKey = `untag:${workspaceId}:${thread.ref.environmentId}:${thread.ref.threadId}`;
        if (inFlight.current.has(flightKey)) continue;
        inFlight.current.add(flightKey);
        void writeTag(thread.ref, tag, false).then((ok) => {
          inFlight.current.delete(flightKey);
          if (!ok) retry();
        });
      }
    }
  }, [registryReady, threadTags, membershipTick]);

  return null;
}
