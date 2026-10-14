import { create } from "zustand";

interface KeepAwakeRuntimeState {
  /** Per environment: does any thread have a turn in flight. */
  runningByEnvironment: Readonly<Record<string, boolean>>;
  /** Whether the desktop process currently holds the blocker. */
  blockerActive: boolean;
  setEnvironmentRunning: (environmentId: string, running: boolean) => void;
  setBlockerActive: (active: boolean) => void;
}

export const useKeepAwakeRuntimeStore = create<KeepAwakeRuntimeState>()((set) => ({
  runningByEnvironment: {},
  blockerActive: false,
  setEnvironmentRunning: (environmentId, running) =>
    set((state) => {
      if ((state.runningByEnvironment[environmentId] ?? false) === running) return state;
      const next = { ...state.runningByEnvironment };
      if (running) next[environmentId] = true;
      else delete next[environmentId];
      return { runningByEnvironment: next };
    }),
  setBlockerActive: (active) => set({ blockerActive: active }),
}));
