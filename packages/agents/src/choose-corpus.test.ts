import { describe, it, expect } from "vitest";
import { parseCorpusPicks } from "./choose.js";

// The model names LABELS — "P17", "U4" — not database ids.
//
// This file used to test the opposite, because the corpus used to embed real ids and ask the
// model to copy them back. Against the real campaign it returned ids of exactly the right shape
// and length that existed nowhere: near-misses of real ones, resolving to no row at all. Copying
// a 25-character opaque string out of a 276,000-token prompt is the thing to ask of a model
// least. A short label it can copy, and a wrong one simply misses the index.

describe("parseCorpusPicks", () => {
  it("reads labels, keeping the model's order", () => {
    expect(
      parseCorpusPicks('[{"ref":"P17","why":"session 81 recap"},{"ref":"U4"}]'),
    ).toEqual([
      { ref: "P17", why: "session 81 recap" },
      { ref: "U4", why: "" },
    ]);
  });

  it("reads it out of a code fence or surrounding prose", () => {
    expect(parseCorpusPicks('Sure:\n```json\n[{"ref":"U9"}]\n```')).toEqual([
      { ref: "U9", why: "" },
    ]);
  });

  it("normalises a lowercase label", () => {
    expect(parseCorpusPicks('[{"ref":" p3 ","why":"x"}]')).toEqual([
      { ref: "P3", why: "x" },
    ]);
  });

  it("treats an empty list as a real answer, not a failure", () => {
    expect(parseCorpusPicks("[]")).toEqual([]);
  });

  it("returns null when the reply isn't a list at all", () => {
    expect(parseCorpusPicks("Nothing in the library matches that.")).toBeNull();
    expect(parseCorpusPicks("[not json")).toBeNull();
  });

  it("accepts a single bare object, not just an array", () => {
    // The real campaign answered "session 81 recap" with exactly this — one object, no brackets,
    // the right label — and an array-first parser discarded it, which read to the DM as
    // "nothing matched".
    expect(
      parseCorpusPicks('{"ref": "P303", "why": "Recap of Session 81"}'),
    ).toEqual([{ ref: "P303", why: "Recap of Session 81" }]);
  });

  it("drops anything that isn't shaped like a label", () => {
    expect(
      parseCorpusPicks(
        '[{"ref":"U1"},{"ref":"banana"},{"why":"no ref at all"},' +
          '{"ref":"X7"},{"ref":"U"},{"ref":"P2"}]',
      ),
    ).toEqual([
      { ref: "U1", why: "" },
      { ref: "P2", why: "" },
    ]);
  });

  it("rejects a raw database id — the shape that caused the trouble", () => {
    expect(
      parseCorpusPicks('[{"ref":"P:cmu4la3fv00vn11o0hcl1d4ag"},{"ref":"U:x"}]'),
    ).toEqual([]);
  });
});
