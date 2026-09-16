import { describe, it, expect } from "vitest";
import {
  isHeadingLine,
  headingsIn,
  opensSection,
  sectionRange,
  sectionFor,
  joinPassages,
  sectionTitle,
  wordCount,
} from "./sections.js";

// A reveal is one-way, so both failure modes are real damage: split a piece and the DM releases
// half a recap; miss a boundary and they release the next session too.
//
// The case that matters most is the one the first version got wrong — a heading in the MIDDLE of
// a passage. The chunker cuts on paragraph edges, so that is where headings actually are.

const p = (chunkIndex: number, text: string) => ({ chunkIndex, text });

describe("isHeadingLine", () => {
  it("sees markdown headings and session lines", () => {
    expect(isHeadingLine("## Session 81 — The Bone Swarm")).toBe(true);
    expect(isHeadingLine("# Vorruk Tower")).toBe(true);
    expect(isHeadingLine("Session 81")).toBe(true);
    expect(isHeadingLine("chapter 3: the vault")).toBe(true);
  });

  it("sees an underlined title, but not a bare rule", () => {
    expect(isHeadingLine("The Bone Swarm", "=============")).toBe(true);
    // The real session log is full of decorative rules; treating each as a boundary would
    // shred every recap into fragments.
    expect(isHeadingLine("-------------")).toBe(false);
    expect(isHeadingLine("They fought on.", "more prose here")).toBe(false);
  });

  it("does not split on prose that merely mentions a session", () => {
    expect(isHeadingLine("They remembered what happened in session 81.")).toBe(
      false,
    );
  });
});

describe("headingsIn — the thing the first version missed", () => {
  it("finds a heading in the middle of a passage, not just at the start", () => {
    const passage = [
      "…and the ship finally moored at dusk.",
      "",
      "Session 82",
      "The next morning they set out again.",
    ].join("\n");
    expect(headingsIn(passage)).toEqual(["Session 82"]);
    expect(opensSection(passage)).toBe(true);
  });

  it("finds several headings in one passage", () => {
    const passage = "# Ildin\nA ranger.\n\n# Morwyn\nA captain.";
    expect(headingsIn(passage)).toEqual(["# Ildin", "# Morwyn"]);
  });

  it("reports none for ordinary prose", () => {
    expect(headingsIn("They fought the swarm.\nThen they rested.")).toEqual([]);
    expect(opensSection("They fought the swarm.")).toBe(false);
  });
});

describe("sectionRange", () => {
  // Headings sit mid-passage, as they do in the real documents.
  const doc = [
    p(0, "Prologue text.\n\nSession 80\nThe first session."),
    p(1, "More of session 80."),
    p(2, "The end of 80.\n\nSession 81\nThe ambush begins."),
    p(3, "The middle of session 81."),
    p(4, "The end of session 81."),
    p(5, "Trailing.\n\nSession 82\nAfterwards."),
  ];

  it("covers the piece from an anchor in its middle", () => {
    expect(sectionRange(doc, 3)).toEqual({ from: 2, to: 4 });
  });

  it("covers the piece from the passage that opens it", () => {
    expect(sectionRange(doc, 2)).toEqual({ from: 2, to: 4 });
  });

  it("stops at the end of the document", () => {
    expect(sectionRange(doc, 5)).toEqual({ from: 5, to: 5 });
  });

  it("treats a document with no headings as one piece", () => {
    const flat = [p(0, "one"), p(1, "two"), p(2, "three")];
    expect(sectionRange(flat, 1)).toEqual({ from: 0, to: 2 });
  });

  it("handles an empty document and an out-of-range anchor", () => {
    expect(sectionRange([], 0)).toEqual({ from: 0, to: -1 });
    expect(sectionRange(doc, 99)).toEqual({ from: 5, to: 5 });
  });
});

describe("sectionFor", () => {
  it("returns the section's passages in order, whatever order they arrive in", () => {
    const rows = [
      p(4, "The end of session 81."),
      p(2, "…\n\nSession 81\nThe ambush begins."),
      p(5, "…\n\nSession 82\nAfterwards."),
      p(3, "The middle of session 81."),
    ];
    expect(sectionFor(rows, 3).map((r) => r.chunkIndex)).toEqual([2, 3, 4]);
  });

  it("returns nothing when the anchor isn't in the document", () => {
    expect(sectionFor([p(0, "# A")], 9)).toEqual([]);
  });
});

describe("joinPassages", () => {
  it("removes the overlap the chunker carried between passages", () => {
    const tail = "the party pressed on through the dark. ";
    const first = `Session 81\nThey fought the swarm. ${tail}`;
    const second = `${tail}Then the tower came into view.`;
    const joined = joinPassages([p(0, first), p(1, second)]);
    expect(joined).toContain("They fought the swarm.");
    expect(joined).toContain("Then the tower came into view.");
    expect(joined.split("the party pressed on").length - 1).toBe(1);
  });

  it("keeps both passages when they don't overlap", () => {
    expect(joinPassages([p(0, "First part."), p(1, "Second part.")])).toBe(
      "First part.\n\nSecond part.",
    );
  });

  it("orders by position, not by the order given", () => {
    expect(joinPassages([p(1, "second"), p(0, "first")])).toBe(
      "first\n\nsecond",
    );
  });
});

describe("sectionTitle", () => {
  it("names the section after its heading, wherever that heading sits", () => {
    expect(
      sectionTitle(
        [p(0, "…prior text.\n\nSession 81\nThe ambush.")],
        "doc.txt",
      ),
    ).toBe("Session 81");
    expect(sectionTitle([p(0, "## Vorruk Tower\nIt looms.")], "doc.md")).toBe(
      "Vorruk Tower",
    );
  });

  it("falls back to the document name when there is no heading", () => {
    expect(sectionTitle([p(0, "just prose")], "Sessions_1-111.txt")).toBe(
      "Sessions_1-111.txt",
    );
  });
});

describe("wordCount", () => {
  it("counts what a reveal would release", () => {
    expect(wordCount("  three  little   words ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
