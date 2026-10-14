import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_MAX_FILES,
  buildResponseHandoffPrompt,
  clipHandoffText,
  formatHandoffChangedFiles,
} from "./responseHandoff.logic";

const base = {
  threadTitle: "Fix login",
  sourceLabel: "Claude Opus 4.6",
  request: "Fix the login bug",
  response: "Done, I patched auth.ts.",
  changedFiles: [{ path: "src/auth.ts", additions: 3, deletions: 1 }],
} as const;

describe("responseHandoff.logic", () => {
  it("builds a handoff prompt with request, response and files", () => {
    const prompt = buildResponseHandoffPrompt({ ...base, kind: "handoff" });
    expect(prompt).toContain(
      "Continue work that was started in another thread with Claude Opus 4.6.",
    );
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("Done, I patched auth.ts.");
    expect(prompt).toContain("- src/auth.ts (+3 -1)");
  });

  it("tells a second opinion not to modify files", () => {
    const prompt = buildResponseHandoffPrompt({ ...base, kind: "second-opinion" });
    expect(prompt).toContain("Do not modify any files.");
  });

  it("omits the request and file sections when there is nothing to show", () => {
    const prompt = buildResponseHandoffPrompt({
      ...base,
      kind: "handoff",
      sourceLabel: null,
      request: null,
      changedFiles: [],
    });
    expect(prompt).toContain("another agent");
    expect(prompt).not.toContain("Original request:");
    expect(prompt).not.toContain("Files changed");
  });

  it("clips long text and long file lists", () => {
    expect(clipHandoffText("a".repeat(30), 10)).toContain("20 more characters omitted");
    const files = Array.from({ length: HANDOFF_MAX_FILES + 3 }, (_, index) => ({
      path: `f${index}.ts`,
      additions: 0,
      deletions: 0,
    }));
    expect(formatHandoffChangedFiles(files)).toContain("... and 3 more files");
  });
});
