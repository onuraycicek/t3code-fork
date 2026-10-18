import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/**
 * Fork: "queue" means "after the agent is done", not "after the current turn".
 *
 * An agent that hands work to a subagent (or another task that reports back)
 * ends its turn and is woken again with the result. Upstream starts the next
 * queued message as soon as the turn ends, so a queued message lands between
 * those parts. This holds a queued user message while such work is pending,
 * and lets the agent's wake turns go first.
 *
 * Claude reports no "finishes" vs "runs forever" signal, so only work that
 * always reports back holds the queue: subagents and other background tasks.
 * Monitors (watchers that wake the agent repeatedly) and background commands
 * (dev servers, waits) never hold it, and the hold ends after
 * FORK_QUEUE_HOLD_MAX_MS of idle time so a lost task cannot strand a message.
 */
export const FORK_QUEUE_HOLD_MAX_MS = 10 * 60_000;

const HOLDING_KINDS: ReadonlySet<string> = new Set(["subagent", "background_task"]);

type HoldProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "messages" | "providerThreads"
>;

/** A message the agent or server wrote to resume itself (background wake, delegated result). */
export function forkIsAgentWake(message: OrchestrationV2ConversationMessage | undefined): boolean {
  return (
    message !== undefined &&
    (message.notification !== undefined ||
      message.delegatedCompletion !== undefined ||
      message.createdBy === "agent" ||
      message.createdBy === "system")
  );
}

/** Sort key: agent wakes before user messages (negative when `left` is a wake and `right` is not). */
export function forkWakeFirst(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  left: OrchestrationV2Run,
  right: OrchestrationV2Run,
): number {
  const isWake = (run: OrchestrationV2Run) =>
    forkIsAgentWake(projection.messages.find((message) => message.id === run.userMessageId));
  return Number(isWake(right)) - Number(isWake(left));
}

function idleSinceMs(runs: HoldProjection["runs"]): number | null {
  let latest: number | null = null;
  for (const run of runs) {
    if (run.completedAt == null) continue;
    const at = DateTime.toEpochMillis(run.completedAt);
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** True when `queuedRun` must keep waiting for the agent's background work. */
export function forkQueueHeldForBackgroundWork(
  projection: HoldProjection,
  queuedRun: OrchestrationV2Run,
  nowMs: number,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === queuedRun.userMessageId);
  if (message === undefined || forkIsAgentWake(message)) return false;
  const holding = projection.providerThreads.some((thread) =>
    (thread.pendingBackgroundTasks ?? []).some((task) => HOLDING_KINDS.has(task.kind)),
  );
  if (!holding) return false;
  const idleSince = idleSinceMs(projection.runs);
  return idleSince === null || nowMs - idleSince < FORK_QUEUE_HOLD_MAX_MS;
}

/** The orchestrator hook: `forkQueueHeldForBackgroundWork` at the current time. */
export const forkQueueHold = (projection: HoldProjection, queuedRun: OrchestrationV2Run) =>
  Effect.map(DateTime.now, (now) =>
    forkQueueHeldForBackgroundWork(projection, queuedRun, DateTime.toEpochMillis(now)),
  );
