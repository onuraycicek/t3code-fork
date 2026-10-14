/**
 * Prompt builders for the "Hand off" and "Second opinion" actions on a completed assistant
 * response. Pure functions: the UI collects the thread data, this file shapes the draft prompt.
 */

export type ResponseHandoffKind = "handoff" | "second-opinion";

export interface ResponseHandoffChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ResponseHandoffInput {
  readonly kind: ResponseHandoffKind;
  readonly threadTitle: string;
  /** Display name of the agent that produced the response, e.g. "Claude Opus 4.6". */
  readonly sourceLabel: string | null;
  /** The user request that started the run, when known. */
  readonly request: string | null;
  readonly response: string;
  readonly changedFiles: ReadonlyArray<ResponseHandoffChangedFile>;
}

export const HANDOFF_REQUEST_MAX_CHARS = 4_000;
export const HANDOFF_RESPONSE_MAX_CHARS = 12_000;
export const HANDOFF_MAX_FILES = 40;

/** Keeps the head of long text and says how much was cut. */
export function clipHandoffText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const omitted = trimmed.length - maxChars;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[... ${omitted} more characters omitted]`;
}

export function formatHandoffChangedFiles(
  files: ReadonlyArray<ResponseHandoffChangedFile>,
): string | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, HANDOFF_MAX_FILES).map((file) => {
    const stats =
      file.additions > 0 || file.deletions > 0 ? ` (+${file.additions} -${file.deletions})` : "";
    return `- ${file.path}${stats}`;
  });
  const hidden = files.length - shown.length;
  if (hidden > 0) shown.push(`- ... and ${hidden} more files`);
  return shown.join("\n");
}

export function buildResponseHandoffPrompt(input: ResponseHandoffInput): string {
  const source = input.sourceLabel === null ? "another agent" : input.sourceLabel;
  const lines: string[] =
    input.kind === "handoff"
      ? [
          `Continue work that was started in another thread with ${source}.`,
          "Check the current state of the workspace before you change anything.",
        ]
      : [
          `Give a second opinion on work that ${source} did in another thread.`,
          "Review it independently: look for bugs, missed requirements and risky assumptions.",
          "Do not modify any files. Report your findings and suggested changes instead.",
        ];

  lines.push("", `Thread: ${input.threadTitle}`);
  if (input.request !== null && input.request.trim().length > 0) {
    lines.push("", "Original request:", clipHandoffText(input.request, HANDOFF_REQUEST_MAX_CHARS));
  }
  lines.push(
    "",
    `Response from ${source}:`,
    clipHandoffText(input.response, HANDOFF_RESPONSE_MAX_CHARS),
  );
  const files = formatHandoffChangedFiles(input.changedFiles);
  if (files !== null) lines.push("", "Files changed in that run:", files);
  lines.push(
    "",
    input.kind === "handoff"
      ? "Pick up from here and finish the remaining work."
      : "Start by reading the changed files and the diff in this workspace.",
  );
  return lines.join("\n");
}
