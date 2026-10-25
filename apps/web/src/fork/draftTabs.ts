import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore, type DraftId, type DraftSessionState } from "../composerDraftStore";

/**
 * A draft tab holds the thread ref its draft session reserved. After the first
 * send that same ref becomes a server thread, so the tab is promoted in place
 * without any layout change.
 */

/** The draft route a tab should navigate to, or null for a server thread tab. */
export function draftRouteIdForTab(threadRef: ScopedThreadRef): DraftId | null {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSessionByRef(threadRef);
  if (!session || session.promotedTo) return null;
  return store.getDraftIdByRef(threadRef);
}

export function useDraftIdByRef(threadRef: ScopedThreadRef | null): DraftId | null {
  return useComposerDraftStore((store) => (threadRef ? store.getDraftIdByRef(threadRef) : null));
}

export function useDraftSessionByRef(threadRef: ScopedThreadRef | null): DraftSessionState | null {
  return useComposerDraftStore((store) =>
    threadRef ? store.getDraftSessionByRef(threadRef) : null,
  );
}

/**
 * Identity key of the chat view in a pane. A draft's view is keyed by its draft
 * id and keeps that key after promotion (the draft record disappears once the
 * thread started), so one ChatView instance carries the draft into the server
 * thread, as ThreadRouteView does for the plain view. Plain threads are unkeyed.
 */
export function useLatchedViewKey(
  threadRef: ScopedThreadRef | null,
  draftId: DraftId | null,
): string | undefined {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const [latched, setLatched] = useState<{ threadKey: string; key: string } | null>(null);
  let next = latched;
  if (threadKey === null) {
    next = null;
  } else if (draftId !== null) {
    if (latched?.threadKey !== threadKey || latched.key !== draftId) {
      next = { threadKey, key: draftId };
    }
  } else if (latched?.threadKey !== threadKey) {
    next = null;
  }
  if (next !== latched) setLatched(next);
  return next?.key;
}
