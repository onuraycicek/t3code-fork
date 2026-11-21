import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "../state/threads";

/** Fork: the workspace registry as served (and changed) by the primary environment. */
export const forkWorkspaceRegistryFeed = createEnvironmentSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "fork:workspaces:registry",
    subscribe: (_input: null) => subscribe(WS_METHODS.forkWorkspacesSubscribe, {}),
  },
);

export const forkWorkspacesUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork:workspaces:update",
  tag: WS_METHODS.forkWorkspacesUpdate,
});

/** Raw orchestration commands; the fork only sends `thread.tag.set` through it. */
export const forkDispatchCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork:workspaces:dispatch",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

export interface ForkThreadTags {
  readonly ref: ScopedThreadRef;
  readonly tags: ReadonlyArray<string>;
}

const EMPTY_TAGS: ReadonlyMap<string, ForkThreadTags> = new Map();

/** The environment key `forkThreadTagsAtom` takes: sorted, newline-joined ids. */
export function forkEnvironmentKey(environmentIds: Iterable<EnvironmentId>): string {
  return [...new Set(environmentIds)].toSorted().join("\n");
}

/**
 * Thread tags by scoped thread key, read from the raw shells because the client thread
 * model leaves tags out.
 */
export const forkThreadTagsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get): ReadonlyMap<string, ForkThreadTags> => {
    if (environmentKey.length === 0) return EMPTY_TAGS;
    const map = new Map<string, ForkThreadTags>();
    for (const environmentId of environmentKey.split("\n") as EnvironmentId[]) {
      const threads: ReadonlyArray<OrchestrationV2ThreadShell> = get(
        environmentThreadShells.environmentThreadsAtom(environmentId),
      );
      for (const thread of threads) {
        const ref = { environmentId, threadId: thread.id };
        map.set(scopedThreadKey(ref), { ref, tags: thread.tags ?? [] });
      }
    }
    return map;
  }).pipe(Atom.withLabel(`fork:workspaces:thread-tags:${environmentKey}`)),
);
