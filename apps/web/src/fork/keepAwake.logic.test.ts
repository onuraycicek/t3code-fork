import { describe, expect, it } from "vite-plus/test";

import { anyThreadRunning, isKeepAwakeMode, shouldKeepAwake } from "./keepAwake.logic";

describe("shouldKeepAwake", () => {
  it("follows the mode", () => {
    expect(shouldKeepAwake("off", true)).toBe(false);
    expect(shouldKeepAwake("always", false)).toBe(true);
    expect(shouldKeepAwake("working", false)).toBe(false);
    expect(shouldKeepAwake("working", true)).toBe(true);
  });
});

describe("anyThreadRunning", () => {
  it("counts in-flight turns and ignores settled or archived threads", () => {
    expect(anyThreadRunning([{ status: "idle" }, { status: "ready" }])).toBe(false);
    expect(anyThreadRunning([{ status: "idle" }, { status: "running" }])).toBe(true);
    expect(anyThreadRunning([{ status: "starting", archivedAt: null }])).toBe(true);
    expect(anyThreadRunning([{ status: "running", archivedAt: "2026-01-01" }])).toBe(false);
  });
});

describe("isKeepAwakeMode", () => {
  it("validates stored values", () => {
    expect(isKeepAwakeMode("working")).toBe(true);
    expect(isKeepAwakeMode("nope")).toBe(false);
  });
});
