import * as Electron from "electron";
import * as Effect from "effect/Effect";

import { updateRequesters } from "./keepAwake.logic.ts";

export const FORK_KEEP_AWAKE_CHANNEL = "fork:keep-awake:set";

/**
 * Fork-only: holds an Electron `prevent-app-suspension` blocker (the system stays
 * awake, the display may sleep) while any window asks for it. The web app decides
 * when (see apps/web/src/fork/KeepAwakeSync.tsx); this side only owns the blocker.
 */
export const installForkKeepAwake = Effect.fn("desktop.fork.installKeepAwake")(function* () {
  let requesters: ReadonlySet<number> = new Set();
  let blockerId: number | null = null;

  const isActive = () => blockerId !== null && Electron.powerSaveBlocker.isStarted(blockerId);
  const sync = () => {
    if (requesters.size > 0 && !isActive()) {
      blockerId = Electron.powerSaveBlocker.start("prevent-app-suspension");
    } else if (requesters.size === 0 && blockerId !== null) {
      if (Electron.powerSaveBlocker.isStarted(blockerId)) {
        Electron.powerSaveBlocker.stop(blockerId);
      }
      blockerId = null;
    }
  };
  const setRequested = (windowId: number, active: boolean) => {
    requesters = updateRequesters(requesters, windowId, active);
    sync();
  };

  Electron.ipcMain.removeHandler(FORK_KEEP_AWAKE_CHANNEL);
  Electron.ipcMain.handle(FORK_KEEP_AWAKE_CHANNEL, (event, active: unknown) => {
    const sender = event.sender;
    const windowId = sender.id;
    const wanted = active === true;
    if (wanted && !requesters.has(windowId)) {
      // A closed or crashed window must not leave the blocker held.
      sender.once("destroyed", () => setRequested(windowId, false));
    }
    setRequested(windowId, wanted);
    return isActive();
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.ipcMain.removeHandler(FORK_KEEP_AWAKE_CHANNEL);
      requesters = new Set();
      sync();
    }),
  );
});
