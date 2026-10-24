import {
  TerminalSessionLookupError,
  type TerminalError,
  type TerminalEvent,
  type TerminalMoveInput,
  type TerminalMoveResult,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Effect from "effect/Effect";

/** The parts of a terminal session the move touches. */
interface MovableSession {
  threadId: string;
  terminalId: string;
  eventSequence: number;
}

interface ManagerStateWithSessions<S> {
  readonly sessions: Map<string, S>;
}

/** Terminal manager internals the move needs; Manager.ts passes its own. */
export interface ForkTerminalMoveDeps<
  S extends MovableSession,
  State extends ManagerStateWithSessions<S>,
  H,
> {
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly readSessions: Effect.Effect<ReadonlyMap<string, S>>;
  readonly modifyManagerState: <A>(f: (state: State) => readonly [A, State]) => Effect.Effect<A>;
  readonly toSessionKey: (threadId: string, terminalId: string) => string;
  readonly closedSessionKeys: Set<string>;
  readonly historyOf: (session: S) => H;
  readonly flushPersist: (threadId: string, terminalId: string) => Effect.Effect<void>;
  readonly persistHistory: (
    threadId: string,
    terminalId: string,
    history: H,
  ) => Effect.Effect<void>;
  readonly deleteHistory: (threadId: string, terminalId: string) => Effect.Effect<void>;
  readonly unregisterTerminal: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  readonly publishEvent: (event: TerminalEvent) => Effect.Effect<void>;
  readonly snapshot: (session: S) => TerminalSessionSnapshot;
  readonly advanceEventSequence: (session: S) => { readonly sequence: number };
}

/**
 * Fork: re-files a session under another thread without touching its process.
 * The session object stays the same, so output, exit and activity keep flowing
 * and are published under the new ids from here on. The source thread sees the
 * terminal close and the target thread sees it start (the metadata stream turns
 * these into remove/upsert), and the history file moves with it. The terminal
 * keeps its id unless the target already has one by that name.
 */
export function forkMakeTerminalMove<
  S extends MovableSession,
  State extends ManagerStateWithSessions<S>,
  H,
>(deps: ForkTerminalMoveDeps<S, State, H>) {
  const moveLocked = Effect.fn("terminal.fork.move")(function* (input: TerminalMoveInput) {
    const sessions = yield* deps.readSessions;
    const sourceKey = deps.toSessionKey(input.threadId, input.terminalId);
    const session = sessions.get(sourceKey);
    if (!session) {
      return yield* new TerminalSessionLookupError({
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
    }
    if (input.targetThreadId === input.threadId) {
      return { threadId: input.threadId, terminalId: input.terminalId };
    }

    const targetIds = [...sessions.values()]
      .filter((candidate) => candidate.threadId === input.targetThreadId)
      .map((candidate) => candidate.terminalId);
    const terminalId = targetIds.includes(input.terminalId)
      ? nextTerminalId(targetIds)
      : input.terminalId;
    const targetKey = deps.toSessionKey(input.targetThreadId, terminalId);

    const closedSequence = session.eventSequence + 1;
    yield* deps.modifyManagerState((state) => {
      const next = new Map(state.sessions);
      next.delete(sourceKey);
      session.threadId = input.targetThreadId;
      session.terminalId = terminalId;
      next.set(targetKey, session);
      deps.closedSessionKeys.add(sourceKey);
      deps.closedSessionKeys.delete(targetKey);
      return [undefined, { ...state, sessions: next }] as const;
    });

    yield* deps.flushPersist(input.threadId, input.terminalId);
    yield* deps.persistHistory(input.targetThreadId, terminalId, deps.historyOf(session));
    yield* deps.deleteHistory(input.threadId, input.terminalId);
    yield* deps.unregisterTerminal({ threadId: input.threadId, terminalId: input.terminalId });

    session.eventSequence = Math.max(session.eventSequence, closedSequence);
    yield* deps.publishEvent({
      type: "closed",
      threadId: input.threadId,
      terminalId: input.terminalId,
      sequence: closedSequence,
    });
    const { sequence } = deps.advanceEventSequence(session);
    yield* deps.publishEvent({
      type: "started",
      threadId: input.targetThreadId,
      terminalId,
      sequence,
      snapshot: deps.snapshot(session),
    });

    return { threadId: input.targetThreadId, terminalId } satisfies TerminalMoveResult;
  });

  // Both threads are locked, in a fixed order so two crossing moves cannot deadlock.
  return (input: TerminalMoveInput): Effect.Effect<TerminalMoveResult, TerminalError> => {
    const [first, second] = [input.threadId, input.targetThreadId].toSorted();
    const locked =
      first === second
        ? deps.withThreadLock(first!, moveLocked(input))
        : deps.withThreadLock(first!, deps.withThreadLock(second!, moveLocked(input)));
    return locked;
  };
}
