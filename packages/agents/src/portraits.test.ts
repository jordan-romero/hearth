import { describe, it, expect } from "vitest";
import { portraitQuery } from "./portraits.js";

describe("portraitQuery", () => {
  it("states race up front and repeats it so matching is race-weighted", () => {
    const q = portraitQuery("Tiefling", "warlock", "curling horns, sinister");
    expect(q.startsWith("A Tiefling.")).toBe(true);
    // race must appear enough times to dominate role/mood in the embedding
    expect((q.match(/Tiefling/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(q).toContain("warlock");
    expect(q).toContain("curling horns, sinister");
  });

  it("trims surrounding whitespace on race", () => {
    const q = portraitQuery("  Elf  ", "priestess", "serene");
    expect(q).toContain("A Elf.");
    expect(q).not.toContain("  Elf  ");
  });
});
