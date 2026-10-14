import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Fork-only preferences. Kept out of the upstream settings schema so the fork
 * does not touch `packages/contracts/src/settings.ts` (fewer rebase conflicts).
 */
interface ForkPrefsState {
  /** Lists active sidebar threads under a header per project. */
  sidebarProjectGroupingEnabled: boolean;
  setSidebarProjectGroupingEnabled: (enabled: boolean) => void;
}

export const useForkPrefsStore = create<ForkPrefsState>()(
  persist(
    (set) => ({
      sidebarProjectGroupingEnabled: true,
      setSidebarProjectGroupingEnabled: (enabled) =>
        set({ sidebarProjectGroupingEnabled: enabled }),
    }),
    {
      name: "t3code:fork-prefs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        sidebarProjectGroupingEnabled: state.sidebarProjectGroupingEnabled,
      }),
    },
  ),
);
