export type KeepAwakeMode = "off" | "working" | "always";

export const KEEP_AWAKE_MODES: ReadonlyArray<{ value: KeepAwakeMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "working", label: "While agents are working" },
  { value: "always", label: "Always" },
];

export function isKeepAwakeMode(value: unknown): value is KeepAwakeMode {
  return value === "off" || value === "working" || value === "always";
}

/** Thread shell statuses that mean a turn is in flight (same set the thread keep-alive uses). */
export function isThreadTurnRunning(thread: {
  readonly status: string;
  readonly archivedAt?: unknown;
}): boolean {
  if (thread.archivedAt !== null && thread.archivedAt !== undefined) return false;
  return (
    thread.status === "preparing" ||
    thread.status === "queued" ||
    thread.status === "starting" ||
    thread.status === "running"
  );
}

export function anyThreadRunning(
  threads: ReadonlyArray<{ readonly status: string; readonly archivedAt?: unknown }>,
): boolean {
  return threads.some(isThreadTurnRunning);
}

export function shouldKeepAwake(mode: KeepAwakeMode, anyRunning: boolean): boolean {
  if (mode === "always") return true;
  return mode === "working" && anyRunning;
}
