import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentSummaries } from "../state/presentation";
import { environmentThreadShells } from "../state/threads";
import { anyThreadRunning, shouldKeepAwake } from "./keepAwake.logic";
import { useKeepAwakeRuntimeStore } from "./keepAwakeStore";
import { useForkPrefsStore } from "./forkPrefsStore";

declare global {
  interface Window {
    /** Fork-only desktop bridge (apps/desktop/src/fork/preload.ts). */
    forkBridge?: { setKeepAwake: (active: boolean) => Promise<boolean> };
  }
}

export const hasKeepAwakeBridge = () =>
  typeof window !== "undefined" && typeof window.forkBridge?.setKeepAwake === "function";

/**
 * Fork-only: tells the desktop process whether to hold a power-save blocker.
 * Renders nothing; a no-op in the plain browser.
 */
export function KeepAwakeSync() {
  const environmentIds = useAtomValue(environmentSummaries.environmentIdsAtom);
  const mode = useForkPrefsStore((state) => state.keepAwakeMode);
  const anyRunning = useKeepAwakeRuntimeStore(
    (state) => Object.keys(state.runningByEnvironment).length > 0,
  );
  const wanted = shouldKeepAwake(mode, anyRunning);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mirrors the wanted state into the desktop power-save blocker over IPC.
  useEffect(() => {
    const bridge = window.forkBridge;
    if (!bridge) return;
    const setActive = useKeepAwakeRuntimeStore.getState().setBlockerActive;
    bridge.setKeepAwake(wanted).then(setActive, () => setActive(false));
  }, [wanted]);

  // Release on unmount (window reload); the main process also drops it when the window dies.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the power-save blocker on unmount.
  useEffect(
    () => () => {
      void window.forkBridge?.setKeepAwake(false);
    },
    [],
  );

  if (!hasKeepAwakeBridge() || mode !== "working") return null;
  return environmentIds.map((environmentId) => (
    <EnvironmentRunningWatcher key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentRunningWatcher({ environmentId }: { environmentId: EnvironmentId }) {
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const running = anyThreadRunning(threads);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publishes this environment's running state to the keep-awake store and clears it on unmount.
  useEffect(() => {
    const store = useKeepAwakeRuntimeStore.getState();
    store.setEnvironmentRunning(environmentId, running);
    return () => store.setEnvironmentRunning(environmentId, false);
  }, [environmentId, running]);
  return null;
}
