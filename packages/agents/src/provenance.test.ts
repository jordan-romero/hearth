import { describe, it, expect } from "vitest";
import {
  checkQuote,
  groupFacts,
  normalizeForQuote,
  renderFacts,
  renderPassages,
  verifySources,
} from "./provenance.js";

// Invented text only. These tests exist so a source is never written that the passage doesn't
// contain — the whole value of provenance is that it can be found but not made up.

const passageA =
  "The lighthouse keeper, Tobin Vale, has not lit the lamp in three winters.\n\nHe claims the oil ran out.";
const passageB = "Ships now steer by the bell buoy off Gull Rock instead.";

const passages = renderPassages([
  { id: "chunk-b", chunkIndex: 1, text: passageB },
  { id: "chunk-a", chunkIndex: 0, text: passageA },
]);
const facts = renderFacts([
  {
    id: "fact-1",
    title: "Tobin Vale",
    content: "The lighthouse keeper; the lamp has been dark for years.",
  },
  { id: "fact-2", title: "Gull Rock", content: "A bell buoy marks it." },
]);

describe("quotes", () => {
  it("accepts an exact copy", () => {
    expect(
      checkQuote("has not lit the lamp in three winters", passageA),
    ).toBeNull();
  });

  it("forgives typography, reflowed whitespace and case — nothing more", () => {
    expect(
      checkQuote("Has  not lit the lamp\nin three winters", passageA),
    ).toBeNull();
    expect(
      checkQuote("The lighthouse keeper, Tobin Vale, has", passageA),
    ).toBeNull();
    expect(normalizeForQuote("“It’s — fine…”")).toBe('"it\'s - fine..."');
  });

  it("rejects a paraphrase", () => {
    expect(checkQuote("has not lit the lamp for three winters", passageA)).toBe(
      "not-in-passage",
    );
  });

  it("rejects a bare name, which appears everywhere and proves nothing", () => {
    expect(checkQuote("Tobin Vale", passageA)).toBe("too-short");
  });

  it("rejects copying the passage wholesale", () => {
    expect(checkQuote("x".repeat(401), "x".repeat(500))).toBe("too-long");
  });
});

describe("labels", () => {
  it("numbers passages in document order, whatever order they arrive in", () => {
    expect(passages.index.get("P1")?.id).toBe("chunk-a");
    expect(passages.index.get("P2")?.id).toBe("chunk-b");
    expect(passages.text.startsWith("[P1] The lighthouse keeper")).toBe(true);
  });

  it("groups facts without dropping any", () => {
    const groups = groupFacts(
      Array.from({ length: 125 }, (_, i) => i),
      60,
    );
    expect(groups.map((g) => g.length)).toEqual([60, 60, 5]);
  });
});

describe("verifySources", () => {
  it("keeps sources whose quote is really in the named passage", () => {
    const result = verifySources(
      {
        facts: [
          {
            fact: "F1",
            sources: [
              { passage: "P1", quote: "has not lit the lamp in three winters" },
              { passage: "p1", quote: "He claims the oil ran out." },
            ],
          },
          {
            fact: "F2",
            sources: [{ passage: "P2", quote: "the bell buoy off Gull Rock" }],
          },
        ],
      },
      passages.index,
      facts.index,
    );
    expect(result.sources).toEqual([
      {
        factId: "fact-1",
        chunkId: "chunk-a",
        quote: "has not lit the lamp in three winters",
      },
      {
        factId: "fact-2",
        chunkId: "chunk-b",
        quote: "the bell buoy off Gull Rock",
      },
    ]);
    expect([...result.linkedFactIds].sort()).toEqual(["fact-1", "fact-2"]);
  });

  it("re-attaches a verbatim quote the model credited to the wrong passage", () => {
    // The words are the evidence; which passage they sit in is checked by code, not trusted.
    const result = verifySources(
      {
        facts: [
          {
            fact: "F2",
            sources: [{ passage: "P1", quote: "the bell buoy off Gull Rock" }],
          },
        ],
      },
      passages.index,
      facts.index,
    );
    expect(result.sources).toEqual([
      {
        factId: "fact-2",
        chunkId: "chunk-b",
        quote: "the bell buoy off Gull Rock",
      },
    ]);
    expect(result.relabelled).toBe(1);
    expect(result.rejected["not-in-passage"]).toBe(0);
  });

  it("re-attaches to the nearest passage when the words appear more than once", () => {
    const repeated = renderPassages([
      { id: "c0", chunkIndex: 0, text: "The tide bell rang twice at dawn." },
      { id: "c1", chunkIndex: 1, text: "Nothing here." },
      { id: "c2", chunkIndex: 2, text: "Nothing here either." },
      { id: "c3", chunkIndex: 3, text: "The tide bell rang twice at dawn." },
    ]);
    const result = verifySources(
      {
        facts: [
          {
            fact: "F1",
            sources: [{ passage: "P3", quote: "tide bell rang twice at dawn" }],
          },
        ],
      },
      repeated.index,
      facts.index,
    );
    expect(result.sources.map((s) => s.chunkId)).toEqual(["c3"]);
  });

  it("still rejects words that are nowhere in the document", () => {
    const result = verifySources(
      {
        facts: [
          {
            fact: "F2",
            sources: [{ passage: "P1", quote: "the bell buoy off Seal Point" }],
          },
        ],
      },
      passages.index,
      facts.index,
    );
    expect(result.sources).toEqual([]);
    expect(result.relabelled).toBe(0);
    expect(result.rejected["not-in-passage"]).toBe(1);
  });

  it("never guesses an unknown fact; re-homes verbatim words under an unknown passage label", () => {
    const result = verifySources(
      {
        facts: [
          {
            fact: "F9",
            sources: [
              { passage: "P1", quote: "has not lit the lamp in three winters" },
            ],
          },
          {
            fact: "F1",
            sources: [
              {
                passage: "chunk-a",
                quote: "has not lit the lamp in three winters",
              },
            ],
          },
        ],
      },
      passages.index,
      facts.index,
    );
    // An unknown fact label is never guessed at. An unknown passage label with verbatim words is
    // re-attached to the passage that really holds them — the label was wrong, not the evidence.
    expect(result.rejected["unknown-fact"]).toBe(1);
    expect(result.sources).toEqual([
      {
        factId: "fact-1",
        chunkId: "chunk-a",
        quote: "has not lit the lamp in three winters",
      },
    ]);
    expect(result.relabelled).toBe(1);
  });

  it("survives a malformed reply without throwing", () => {
    for (const junk of [
      null,
      "text",
      { facts: "nope" },
      { facts: [null, { fact: 3 }] },
    ]) {
      expect(verifySources(junk, passages.index, facts.index).sources).toEqual(
        [],
      );
    }
  });
});
