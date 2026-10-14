import { contextBridge, ipcRenderer } from "electron";

// Kept literal (not imported from keepAwake.ts) so the sandboxed preload never
// pulls the main-process Electron API into its bundle.
const FORK_KEEP_AWAKE_CHANNEL = "fork:keep-awake:set";

/** Fork-only bridge, separate from the upstream typed `desktopBridge`. */
contextBridge.exposeInMainWorld("forkBridge", {
  /** Resolves to whether the blocker is held after the call. */
  setKeepAwake: (active: boolean): Promise<boolean> =>
    ipcRenderer.invoke(FORK_KEEP_AWAKE_CHANNEL, active),
});
