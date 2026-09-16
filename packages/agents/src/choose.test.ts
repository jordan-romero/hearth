import { describe, it, expect } from "vitest";
import { parseRankingReply } from "./choose.js";

// These become buttons that reveal things one-way, so the parser has to be strict about what
// it accepts and honest (null) when the reply isn't a ranking at all.

describe("parseRankingReply", () => {
  it("reads a plain ranking", () => {
    expect(
      parseRankingReply('[{"ref":"U3","why":"names Moira directly"}]'),
    ).toEqual([{ ref: "U3", why: "names Moira directly" }]);
  });

  it("reads it out of a code fence or surrounding prose", () => {
    expect(
      parseRankingReply(
        'Here you go:\n```json\n[{"ref":"D2","why":"her dossier"}]\n```',
      ),
    ).toEqual([{ ref: "D2", why: "her dossier" }]);
  });

  it("keeps the model's order", () => {
    const picks = parseRankingReply('[{"ref":"U5"},{"ref":"U1"},{"ref":"D1"}]');
    expect(picks?.map((p) => p.ref)).toEqual(["U5", "U1", "D1"]);
  });

  it("treats an empty list as a real answer, not a failure", () => {
    expect(parseRankingReply("[]")).toEqual([]);
  });

  it("returns null when the reply isn't a ranking, so the caller can fall back", () => {
    expect(parseRankingReply("I couldn't find anything relevant.")).toBeNull();
    expect(parseRankingReply("[this is not json")).toBeNull();
    expect(parseRankingReply('{"ref":"U1"}')).toBeNull();
  });

  it("drops entries that aren't a candidate reference", () => {
    expect(
      parseRankingReply(
        '[{"ref":"U1"},{"ref":"banana"},{"why":"no ref"},{"ref":"U2"}]',
      ),
    ).toEqual([
      { ref: "U1", why: "" },
      { ref: "U2", why: "" },
    ]);
  });

  it("normalises a lowercase reference", () => {
    expect(parseRankingReply('[{"ref":" u4 ","why":"x"}]')).toEqual([
      { ref: "U4", why: "x" },
    ]);
  });
});
