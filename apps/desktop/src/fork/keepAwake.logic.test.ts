import { describe, expect, it } from "vite-plus/test";

import { updateRequesters } from "./keepAwake.logic.ts";

describe("updateRequesters", () => {
  it("adds and removes window ids", () => {
    const a = updateRequesters(new Set(), 1, true);
    expect([...a]).toEqual([1]);
    const b = updateRequesters(a, 2, true);
    expect([...b]).toEqual([1, 2]);
    expect([...updateRequesters(b, 1, false)]).toEqual([2]);
  });

  it("returns the same set when nothing changes", () => {
    const a = new Set([1]);
    expect(updateRequesters(a, 1, true)).toBe(a);
    expect(updateRequesters(a, 3, false)).toBe(a);
  });
});
