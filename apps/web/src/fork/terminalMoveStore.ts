import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** Fork: the terminal the "Move to chat" picker is open for, if any. */
export interface TerminalMoveRequest {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly label: string;
}

interface TerminalMoveStoreState {
  readonly request: TerminalMoveRequest | null;
  readonly open: (request: TerminalMoveRequest) => void;
  readonly close: () => void;
}

export const useTerminalMoveStore = create<TerminalMoveStoreState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function requestTerminalMove(request: TerminalMoveRequest): void {
  useTerminalMoveStore.getState().open(request);
}
