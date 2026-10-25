import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * Fork: re-checks idle threads with queued messages every 30 s. Background work
 * can end without a wake (killed task, closed session) and the hold expires on
 * a timer; this sweep starts the queue in those cases.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      orchestrator.resumeQueuedRuns.pipe(
        Effect.catchCause((cause) => Effect.logWarning("fork queue hold sweep failed", { cause })),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.asVoid,
      ),
    );
  }),
);
