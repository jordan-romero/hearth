import { describe, it, expect } from "vitest";
import { sourceStatus } from "./link-sources.js";

describe("sourceStatus", () => {
  const source = (factId: string) => ({
    factId,
    chunkId: "c1",
    quote: "words that were there",
  });

  it("marks a checked fact with a verified source SOURCED, and one without UNSOURCED", () => {
    expect(sourceStatus(["a", "b"], [source("a")])).toEqual({
      sourced: ["a"],
      unsourced: ["b"],
    });
  });

  it("never judges a fact that wasn't checked", () => {
    // A failed or truncated group leaves its facts UNCHECKED — usable — not UNSOURCED.
    const { sourced, unsourced } = sourceStatus(
      ["a"],
      [source("a"), source("z")],
    );
    expect(sourced).toEqual(["a"]);
    expect(unsourced).toEqual([]);
  });

  it("counts a fact once however many passages support it", () => {
    expect(
      sourceStatus(["a", "a"], [source("a"), source("a")]).sourced,
    ).toEqual(["a"]);
  });
});
