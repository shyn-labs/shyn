import { describe, it, expect } from "vitest";
import { live } from "../src/live.js";

describe("live", () => {
  it("passes through an object that is not destroyed", () => {
    const w = { isDestroyed: () => false };
    expect(live(w)).toBe(w);
  });

  it("nulls out a destroyed object", () => {
    expect(live({ isDestroyed: () => true })).toBeNull();
  });

  it("nulls out null", () => {
    expect(live(null)).toBeNull();
  });
});
