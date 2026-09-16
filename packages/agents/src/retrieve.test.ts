import { describe, it, expect } from "vitest";
import { literalPhrases, literalPhrasePattern } from "./retrieve.js";

// The bug these exist for: asking to reveal "session 1 recap" offered session 81, because
// nearest-by-meaning can't tell those numbers apart.

describe("literalPhrases — what a question names exactly", () => {
  it("picks up a word followed by a number", () => {
    expect(literalPhrases("reveal session 1 recap to party")).toEqual([
      "session 1",
    ]);
  });

  it("handles a hash and missing space", () => {
    expect(literalPhrases("session #111")).toEqual(["session 111"]);
    expect(literalPhrases("Chapter3 notes")).toEqual(["chapter 3"]);
  });

  it("lowercases and de-duplicates", () => {
    expect(literalPhrases("Session 5 and session 5 again")).toEqual([
      "session 5",
    ]);
  });

  it("finds nothing in a question with no numbers", () => {
    expect(literalPhrases("info on recent events")).toEqual([]);
  });
});

describe("literalPhrasePattern — matching those phrases as whole words", () => {
  // The pattern is Postgres regex; translate its word boundaries and character class so the
  // same string can be checked with JavaScript's engine.
  const matches = (pattern: string, text: string) =>
    new RegExp(
      pattern
        .replace(/\\m/g, "\\b")
        .replace(/\\M/g, "\\b")
        .replace(/\[\[:space:\]\]/g, "\\s"),
      "i",
    ).test(text);

  it("is null when the question named nothing exact", () => {
    expect(literalPhrasePattern([])).toBeNull();
  });

  it("matches the session it names", () => {
    const pattern = literalPhrasePattern(["session 1"])!;
    expect(matches(pattern, "Ambush at Dawn (Session 1)")).toBe(true);
    expect(matches(pattern, "session #1 recap")).toBe(true);
  });

  it("does NOT match a longer number — the actual bug", () => {
    const pattern = literalPhrasePattern(["session 1"])!;
    expect(matches(pattern, "Ambush and Bone Swarm Battle (Session 81)")).toBe(
      false,
    );
    expect(matches(pattern, "Sessions_1-111 (Session 111)")).toBe(false);
  });

  it("matches any of several phrases", () => {
    const pattern = literalPhrasePattern(["session 1", "chapter 3"])!;
    expect(matches(pattern, "Chapter 3: the vault")).toBe(true);
    expect(matches(pattern, "Session 1 — recruitment")).toBe(true);
    expect(matches(pattern, "Session 12 — the road")).toBe(false);
  });
});
