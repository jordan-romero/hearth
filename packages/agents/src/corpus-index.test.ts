import { describe, it, expect } from "vitest";
import {
  assembleCorpus,
  estimateTokens,
  type CorpusChunk,
  type CorpusUnit,
} from "./corpus.js";
import type { Viewer } from "@hearth/core";

// The index is how a model's answer becomes a real record, so the label in the text and the entry
// in the map must never disagree. They are built in one pass for that reason, and these are the
// cases where a second pass would have drifted: labels running across documents, a document
// dropped for budget, facts that didn't fit.

function unit(over: Partial<CorpusUnit> & Pick<CorpusUnit, "id">): CorpusUnit {
  return {
    campaignId: "c1",
    baseVisibility: "DM_ONLY",
    title: `title-${over.id}`,
    content: `content-${over.id}`,
    type: "FACT",
    authorName: null,
    sourceDocumentId: null,
    grantedCharacterIds: [],
    grantedPartyIds: [],
    ...over,
  };
}

function chunk(
  over: Partial<CorpusChunk> & Pick<CorpusChunk, "id">,
): CorpusChunk {
  return {
    campaignId: "c1",
    baseVisibility: "DM_ONLY",
    sourceDocumentId: "doc-1",
    docName: "NPCS.md",
    chunkIndex: 0,
    text: `text-${over.id}`,
    grantedCharacterIds: [],
    grantedPartyIds: [],
    ...over,
  };
}

const dm: Viewer = {
  campaignId: "c1",
  role: "DM",
  characterId: null,
  partyId: null,
};

const all = (c: { shared: string; personal: string }) =>
  `${c.shared}\n${c.personal}`;

describe("the corpus index", () => {
  it("labels every passage and fact, and resolves each to its row", () => {
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "fact-a" })],
      [chunk({ id: "k1" }), chunk({ id: "k2", chunkIndex: 1 })],
    );
    expect(corpus.index.get("P1")).toEqual({ kind: "passage", id: "k1" });
    expect(corpus.index.get("P2")).toEqual({ kind: "passage", id: "k2" });
    expect(corpus.index.get("U1")).toEqual({ kind: "unit", id: "fact-a" });
    expect(all(corpus)).toContain("[P1]");
    expect(all(corpus)).toContain("[U1]");
  });

  it("numbers passages across documents, not per document", () => {
    // "P3" has to mean one thing in the whole prompt.
    const corpus = assembleCorpus(
      dm,
      [],
      [
        chunk({ id: "a1", docName: "A.md", sourceDocumentId: "A" }),
        chunk({
          id: "a2",
          docName: "A.md",
          sourceDocumentId: "A",
          chunkIndex: 1,
        }),
        chunk({ id: "b1", docName: "B.md", sourceDocumentId: "B" }),
      ],
    );
    expect(corpus.index.get("P3")).toEqual({ kind: "passage", id: "b1" });
    expect([...corpus.index.keys()].sort()).toEqual(["P1", "P2", "P3"]);
  });

  it("never labels material the model was not given", () => {
    // A document dropped for budget must not consume labels, or every later one is off by its
    // length and the index names passages that aren't in the prompt.
    const big = (id: string, docName: string) =>
      chunk({
        id,
        docName,
        sourceDocumentId: docName,
        text: "x".repeat(4000),
      });
    const corpus = assembleCorpus(
      dm,
      [],
      [big("k1", "A.md"), big("k2", "B.md")],
      estimateTokens("x".repeat(4000)) + 10,
    );
    expect(corpus.manifest.omittedDocuments).toEqual(["B.md"]);
    expect(corpus.index.get("P1")).toEqual({ kind: "passage", id: "k1" });
    expect(corpus.index.has("P2")).toBe(false);
  });

  it("does not label facts that the budget left out", () => {
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "big-fact", content: "y".repeat(4000) })],
      [chunk({ id: "k1", text: "x".repeat(4000) })],
      estimateTokens("x".repeat(4000)) + 10,
    );
    expect(corpus.manifest.omittedFacts).toBe(1);
    expect(corpus.index.has("U1")).toBe(false);
    expect(corpus.index.get("P1")).toEqual({ kind: "passage", id: "k1" });
  });

  it("gives a player labels only for what a player may see", () => {
    const alice: Viewer = {
      campaignId: "c1",
      role: "PLAYER",
      characterId: "char-alice",
      partyId: "party-1",
    };
    const corpus = assembleCorpus(
      alice,
      [unit({ id: "secret" })],
      [chunk({ id: "open", baseVisibility: "EVERYONE" })],
    );
    expect(corpus.index.get("P1")).toEqual({ kind: "passage", id: "open" });
    expect([...corpus.index.values()].map((r) => r.id)).not.toContain("secret");
  });
});
