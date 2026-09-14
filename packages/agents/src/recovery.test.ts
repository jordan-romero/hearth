import { describe, it, expect } from "vitest";
import { interruptedEndedAt } from "./recovery.js";

describe("interruptedEndedAt — when a recording cut off by a restart ended", () => {
  const startedAt = new Date("2026-09-08T00:52:40Z");

  it("ends at the last captured clip", () => {
    const lastClip = new Date("2026-09-08T00:53:34Z");
    expect(interruptedEndedAt(startedAt, lastClip)).toEqual(lastClip);
  });

  it("ends at its start when it captured nothing", () => {
    expect(interruptedEndedAt(startedAt, null)).toEqual(startedAt);
  });

  it("never ends before it started, even with a skewed clip time", () => {
    const skewed = new Date("2026-09-08T00:50:00Z");
    expect(interruptedEndedAt(startedAt, skewed)).toEqual(startedAt);
  });
});
