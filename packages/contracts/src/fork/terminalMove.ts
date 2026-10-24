import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * Fork: hands a live terminal session to another thread. The process keeps
 * running; only the thread (and, on a clash, the terminal id) it is filed
 * under changes. The server picks the id in the target thread.
 */
export const TerminalMoveInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  targetThreadId: TrimmedNonEmptyString,
});
export type TerminalMoveInput = typeof TerminalMoveInput.Type;

export const TerminalMoveResult = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});
export type TerminalMoveResult = typeof TerminalMoveResult.Type;
