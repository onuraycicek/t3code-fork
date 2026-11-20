/**
 * The workspace a window opens on: its own from before a reload, else the remembered
 * one (main window), else the first one no other window has open. Null when all are busy.
 */
export function pickWorkspaceForWindow(input: {
  readonly ids: readonly string[];
  readonly sessionId: string | null;
  readonly rememberedId: string | null;
  readonly busyIds: readonly string[];
}): string | null {
  const busy = new Set(input.busyIds);
  const usable = (id: string | null): id is string =>
    id !== null && input.ids.includes(id) && !busy.has(id);
  if (usable(input.sessionId)) return input.sessionId;
  if (usable(input.rememberedId)) return input.rememberedId;
  return input.ids.find((id) => !busy.has(id)) ?? null;
}

/** "Workspace N" with the lowest N not taken. */
export function nextWorkspaceName(names: readonly string[]): string {
  const taken = new Set(names);
  for (let n = 2; ; n += 1) {
    const name = `Workspace ${n}`;
    if (!taken.has(name)) return name;
  }
}
