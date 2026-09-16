import { describe, it, expect } from "vitest";
import { parseCorpusPicks } from "./choose.js";

// The failure this file exists for, found against the real campaign rather than imagined:
//
// The model thinks before replying, and thinking shares the output budget. On a harder question
// it thought for twenty-three seconds and was cut off mid-entry, leaving a reply like
//   [{"ref": "P17", "why": "Full NPC profile"},
//    {"ref": "P42", "why": "Describes her relat
// JSON.parse threw on that, the whole list was discarded, and the DM was told nothing in their
// library matched — on a library that plainly contained the answer. One truncated tail must cost
// one candidate, not all of them.

describe("a reply cut off mid-entry", () => {
  it("keeps the entries that are complete", () => {
    const truncated =
      '[{"ref": "P17", "why": "Full NPC profile on her"},\n' +
      '{"ref": "P42", "why": "Describes her relat';
    expect(parseCorpusPicks(truncated)).toEqual([
      { ref: "P17", why: "Full NPC profile on her" },
    ]);
  });

  it("keeps several complete entries when only the last is cut", () => {
    const truncated = '[{"ref":"U1"},{"ref":"P2"},{"ref":"U3"},{"ref":"P';
    expect(parseCorpusPicks(truncated)?.map((p) => p.ref)).toEqual([
      "U1",
      "P2",
      "U3",
    ]);
  });

  it("still reports a failure when nothing complete survived", () => {
    // Not "nothing matched" — there is a difference, and the DM deserves the right one.
    expect(parseCorpusPicks('[{"ref": "P17", "why": "cut off here')).toBeNull();
  });

  it("still treats a genuinely empty list as an answer", () => {
    expect(parseCorpusPicks("[]")).toEqual([]);
    expect(parseCorpusPicks("  [ ]  ")).toEqual([]);
  });

  it("still refuses prose that never became a list", () => {
    expect(parseCorpusPicks("I could not find anything about her.")).toBeNull();
  });
});
