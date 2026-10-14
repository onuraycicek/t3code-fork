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
 * An agent that starts background work (a subagent, a monitor, a background
 * command such as a build watcher) ends its turn and is woken again when that
 * work finishes. Upstream starts the next queued message as soon as the turn
 * ends, so a queued message lands between those parts. This holds a queued
 * user message while the thread's provider threads still report pending
 * background work, and lets the agent's wake turns go first.
 *
 * Background commands carry no "finishes soon" vs "runs forever" signal (a dev
 * server and a build watcher look the same), so they hold the queue only for
 * FORK_QUEUE_COMMAND_WAIT_MS after the agent went idle.
 */
export const FORK_QUEUE_COMMAND_WAIT_MS = 15 * 60_000;

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
  const tasks = projection.providerThreads.flatMap((thread) => thread.pendingBackgroundTasks ?? []);
  if (tasks.length === 0) return false;
  if (tasks.some((task) => task.kind !== "command")) return true;
  const idleSince = idleSinceMs(projection.runs);
  return idleSince === null || nowMs - idleSince < FORK_QUEUE_COMMAND_WAIT_MS;
}

/** The orchestrator hook: `forkQueueHeldForBackgroundWork` at the current time. */
export const forkQueueHold = (projection: HoldProjection, queuedRun: OrchestrationV2Run) =>
  Effect.map(DateTime.now, (now) =>
    forkQueueHeldForBackgroundWork(projection, queuedRun, DateTime.toEpochMillis(now)),
  );
