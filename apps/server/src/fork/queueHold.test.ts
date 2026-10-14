import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import { FORK_QUEUE_COMMAND_WAIT_MS, forkQueueHeldForBackgroundWork } from "./queueHold.ts";

const IDLE_AT = Date.parse("2026-10-15T10:00:00.000Z");

function projection(tasks: ReadonlyArray<{ kind: string }>) {
  return {
    messages: [
      { id: "message:user", createdBy: "user" },
      {
        id: "message:wake",
        createdBy: "agent",
        notification: { source: { kind: "background_task" }, outcome: "updated", summary: "x" },
      },
    ],
    runs: [
      {
        id: "run:done",
        ordinal: 1,
        status: "completed",
        completedAt: DateTime.makeUnsafe(IDLE_AT),
      },
      {
        id: "run:user",
        ordinal: 2,
        queuePosition: 1,
        status: "queued",
        userMessageId: "message:user",
        completedAt: null,
      },
      {
        id: "run:wake",
        ordinal: 3,
        queuePosition: 2,
        status: "queued",
        userMessageId: "message:wake",
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: "provider-thread:1",
        pendingBackgroundTasks: tasks.map((task, index) => ({ taskId: `t${index}`, ...task })),
      },
    ],
  } as never;
}

const userRun = { userMessageId: "message:user" } as never;
const wakeRun = { userMessageId: "message:wake" } as never;

describe("fork queue hold", () => {
  it("lets the queue go when the agent has no background work", () => {
    expect(forkQueueHeldForBackgroundWork(projection([]), userRun, IDLE_AT)).toBe(false);
  });

  it("holds a user message while a subagent or monitor can still wake the agent", () => {
    expect(
      forkQueueHeldForBackgroundWork(
        projection([{ kind: "subagent" }]),
        userRun,
        IDLE_AT + 3_600_000,
      ),
    ).toBe(true);
    expect(
      forkQueueHeldForBackgroundWork(projection([{ kind: "monitor" }]), userRun, IDLE_AT),
    ).toBe(true);
  });

  it("holds a user message behind a background command only for the wait window", () => {
    const commands = projection([{ kind: "command" }]);
    expect(forkQueueHeldForBackgroundWork(commands, userRun, IDLE_AT + 60_000)).toBe(true);
    expect(
      forkQueueHeldForBackgroundWork(commands, userRun, IDLE_AT + FORK_QUEUE_COMMAND_WAIT_MS),
    ).toBe(false);
  });

  it("never holds the agent's own wake", () => {
    expect(
      forkQueueHeldForBackgroundWork(projection([{ kind: "subagent" }]), wakeRun, IDLE_AT),
    ).toBe(false);
  });

  it("delivers the agent's wake before a user message queued earlier", () => {
    expect(queuedRunsInDeliveryOrder(projection([])).map((run) => run.id)).toEqual([
      "run:wake",
      "run:user",
    ]);
  });
});
