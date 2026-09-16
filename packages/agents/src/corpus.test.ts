import { describe, it, expect } from "vitest";
import {
  assembleCorpus,
  estimateTokens,
  type CorpusChunk,
  type CorpusUnit,
} from "./corpus.js";
import type { Viewer } from "@hearth/core";

// This module puts a whole campaign in front of a model, so a mistake here is not a wrong
// passage — it is the DM's secrets in a player's answer. Every case pairs what a viewer may see
// with what they must NOT.

function unit(over: Partial<CorpusUnit> & Pick<CorpusUnit, "id">): CorpusUnit {
  return {
    campaignId: "c1",
    baseVisibility: "DM_ONLY",
    title: `title-${over.id}`,
    content: `content-${over.id}`,
    type: "FACT",
    authorName: null,
    // Null by default: a fact with no document behind it is never deduped, so the cases that
    // aren't about deduplication are unaffected by it.
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
const alice: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: "char-alice",
  partyId: "party-1",
};
const bob: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: "char-bob",
  partyId: "party-2",
};
const otherCampaign: Viewer = {
  campaignId: "c2",
  role: "DM",
  characterId: null,
  partyId: null,
};

const all = (c: { shared: string; personal: string }) =>
  `${c.shared}\n${c.personal}`;

describe("who sees what", () => {
  it("gives the DM everything in their campaign", () => {
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "u1" }), unit({ id: "u2", baseVisibility: "EVERYONE" })],
      [chunk({ id: "k1" })],
    );
    expect(all(corpus)).toContain("content-u1");
    expect(all(corpus)).toContain("content-u2");
    expect(all(corpus)).toContain("text-k1");
    expect(corpus.manifest.factCount).toBe(2);
  });

  it("never gives a player DM-only material", () => {
    const corpus = assembleCorpus(
      alice,
      [unit({ id: "secret" })],
      [chunk({ id: "secret-passage" })],
    );
    expect(all(corpus)).not.toContain("content-secret");
    expect(all(corpus)).not.toContain("text-secret-passage");
    expect(corpus.manifest.factCount).toBe(0);
    expect(corpus.manifest.passageCount).toBe(0);
  });

  it("gives a player what was revealed to their character, and not to another's", () => {
    const units = [
      unit({ id: "for-alice", grantedCharacterIds: ["char-alice"] }),
      unit({ id: "for-bob", grantedCharacterIds: ["char-bob"] }),
    ];
    expect(all(assembleCorpus(alice, units, []))).toContain(
      "content-for-alice",
    );
    expect(all(assembleCorpus(alice, units, []))).not.toContain(
      "content-for-bob",
    );
    expect(all(assembleCorpus(bob, units, []))).toContain("content-for-bob");
    expect(all(assembleCorpus(bob, units, []))).not.toContain(
      "content-for-alice",
    );
  });

  it("gives a player what was revealed to their party only", () => {
    const units = [unit({ id: "party-1-only", grantedPartyIds: ["party-1"] })];
    expect(all(assembleCorpus(alice, units, []))).toContain(
      "content-party-1-only",
    );
    expect(all(assembleCorpus(bob, units, []))).not.toContain(
      "content-party-1-only",
    );
  });

  it("refuses another campaign's material even to a DM", () => {
    const corpus = assembleCorpus(
      otherCampaign,
      [unit({ id: "u1" })],
      [chunk({ id: "k1" })],
    );
    expect(all(corpus)).not.toContain("content-u1");
    expect(all(corpus)).not.toContain("text-k1");
  });
});

describe("what can be cached", () => {
  it("puts campaign-wide material in shared and revealed-to-me material in personal", () => {
    const corpus = assembleCorpus(
      alice,
      [
        unit({ id: "everyone", baseVisibility: "EVERYONE" }),
        unit({ id: "mine", grantedCharacterIds: ["char-alice"] }),
      ],
      [],
    );
    expect(corpus.shared).toContain("content-everyone");
    expect(corpus.shared).not.toContain("content-mine");
    expect(corpus.personal).toContain("content-mine");
  });

  it("keeps a document out of a player's shared block if any passage in it was revealed to them alone", () => {
    const corpus = assembleCorpus(
      alice,
      [],
      [
        chunk({ id: "k1", baseVisibility: "EVERYONE" }),
        chunk({
          id: "k2",
          chunkIndex: 1,
          grantedCharacterIds: ["char-alice"],
        }),
      ],
    );
    expect(corpus.shared).not.toContain("text-k2");
    expect(corpus.personal).toContain("text-k2");
  });

  it("caches the DM's whole campaign, DM-only material included", () => {
    // The one viewer whose library is entirely DM_ONLY is the DM. Splitting their corpus by
    // visibility would leave nothing in the cacheable prefix — the case this exists for.
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "secret" })],
      [chunk({ id: "secret-passage" })],
    );
    expect(corpus.shared).toContain("content-secret");
    expect(corpus.shared).toContain("text-secret-passage");
    expect(corpus.personal).toBe("");
  });

  it("is byte-identical between calls, so the cache prefix holds", () => {
    const units = [
      unit({ id: "b", baseVisibility: "EVERYONE" }),
      unit({ id: "a", baseVisibility: "EVERYONE" }),
    ];
    const chunks = [
      chunk({ id: "k2", chunkIndex: 1, baseVisibility: "EVERYONE" }),
      chunk({ id: "k1", chunkIndex: 0, baseVisibility: "EVERYONE" }),
    ];
    const first = assembleCorpus(dm, units, chunks).shared;
    // Same material, arriving in a different order from the database.
    const second = assembleCorpus(dm, [...units].reverse(), [...chunks]).shared;
    expect(second).toBe(first);
    // And the passage order within a document follows the document, not the query.
    expect(first.indexOf("text-k1")).toBeLessThan(first.indexOf("text-k2"));
  });

  it("gives two players the same shared block", () => {
    const units = [
      unit({ id: "everyone", baseVisibility: "EVERYONE" }),
      unit({ id: "for-alice", grantedCharacterIds: ["char-alice"] }),
    ];
    expect(assembleCorpus(alice, units, []).shared).toBe(
      assembleCorpus(bob, units, []).shared,
    );
  });
});

describe("the budget", () => {
  const big = (id: string, docName: string, size: number): CorpusChunk =>
    chunk({
      id,
      docName,
      sourceDocumentId: docName,
      baseVisibility: "EVERYONE",
      text: "x".repeat(size),
    });

  it("drops a document whole rather than truncating it", () => {
    const budget = estimateTokens("x".repeat(4000)) + 10;
    const corpus = assembleCorpus(
      dm,
      [],
      [big("k1", "A.md", 4000), big("k2", "B.md", 4000)],
      budget,
    );
    expect(corpus.manifest.documents).toEqual(["A.md"]);
    expect(corpus.manifest.omittedDocuments).toEqual(["B.md"]);
    expect(corpus.manifest.complete).toBe(false);
  });

  it("reports a complete corpus when everything fits", () => {
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "u1" })],
      [chunk({ id: "k1" })],
    );
    expect(corpus.manifest.complete).toBe(true);
    expect(corpus.manifest.omittedDocuments).toEqual([]);
    expect(corpus.manifest.tokens).toBeGreaterThan(0);
  });

  it("still refuses hidden material when the budget is generous", () => {
    const corpus = assembleCorpus(
      alice,
      [unit({ id: "secret" })],
      [chunk({ id: "secret-passage" })],
      1_000_000,
    );
    expect(all(corpus)).not.toContain("content-secret");
  });

  it("treats the budget as a ceiling, not a suggestion", () => {
    // Facts used to be appended without checking, so the corpus could exceed its own budget —
    // the real campaign reported 164,773 tokens against a budget of 150,000.
    const budget = estimateTokens("x".repeat(4000)) + 10;
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "from-play", content: "y".repeat(4000) })],
      [
        chunk({
          id: "k1",
          docName: "A.md",
          sourceDocumentId: "A.md",
          text: "x".repeat(4000),
        }),
      ],
      budget,
    );
    expect(corpus.manifest.tokens).toBeLessThanOrEqual(budget);
    expect(corpus.manifest.omittedFacts).toBe(1);
    expect(corpus.manifest.complete).toBe(false);
    expect(all(corpus)).not.toContain("yyyy");
  });
});

describe("not sending the same content twice", () => {
  // Every fact in the real campaign was extracted from an uploaded document. Sending both turned
  // a 178k-token library into 233k — past a context window — and forced documents to be dropped.
  it("leaves out a fact extracted from a document that is already here", () => {
    const corpus = assembleCorpus(
      dm,
      [
        unit({ id: "derived", sourceDocumentId: "doc-1" }),
        unit({ id: "from-play" }), // no document behind it
      ],
      [chunk({ id: "k1", sourceDocumentId: "doc-1" })],
    );
    expect(all(corpus)).not.toContain("content-derived");
    expect(all(corpus)).toContain("content-from-play");
    expect(corpus.manifest.duplicateFactsOmitted).toBe(1);
    expect(corpus.manifest.factCount).toBe(1);
  });

  it("keeps a fact whose document was dropped — it is the only trace of it left", () => {
    // Headroom for one small fact, but nowhere near enough for the second document: this is
    // about what survives a drop, not about the ceiling itself.
    const budget = estimateTokens("x".repeat(4000)) + 60;
    const big = (id: string, docName: string) =>
      chunk({
        id,
        docName,
        sourceDocumentId: docName,
        baseVisibility: "EVERYONE",
        text: "x".repeat(4000),
      });
    const corpus = assembleCorpus(
      dm,
      [unit({ id: "from-b", sourceDocumentId: "B.md" })],
      [big("k1", "A.md"), big("k2", "B.md")],
      budget,
    );
    expect(corpus.manifest.omittedDocuments).toEqual(["B.md"]);
    expect(all(corpus)).toContain("content-from-b");
    expect(corpus.manifest.duplicateFactsOmitted).toBe(0);
  });

  it("deduplicates a player's corpus against what the player can actually see", () => {
    const corpus = assembleCorpus(
      alice,
      [
        unit({
          id: "derived",
          baseVisibility: "EVERYONE",
          sourceDocumentId: "doc-1",
        }),
      ],
      [
        chunk({
          id: "k1",
          baseVisibility: "EVERYONE",
          sourceDocumentId: "doc-1",
        }),
      ],
    );
    expect(all(corpus)).not.toContain("content-derived");
    expect(corpus.manifest.duplicateFactsOmitted).toBe(1);
  });
});
