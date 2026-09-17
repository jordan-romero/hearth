import { describe, it, expect } from "vitest";
import {
  matchEntities,
  wantsBriefing,
  withShortNames,
} from "./graph-context.js";

const aliases = [
  { entityId: "moira", alias: "Moira Vane" },
  { entityId: "moira", alias: "the Widow" },
  { entityId: "morwyn", alias: "Morwyn" },
  { entityId: "hale", alias: "Hale" },
  { entityId: "captain", alias: "Captain Hale Morrow" },
  { entityId: "al", alias: "Al" },
];

describe("matchEntities", () => {
  it("finds a subject by any of its names", () => {
    expect(
      matchEntities("Tell me everything about the Widow", aliases),
    ).toEqual(["moira"]);
    expect(matchEntities("what's moira vane's deal?", aliases)).toEqual([
      "moira",
    ]);
  });

  it("never reads Moira as Morwyn, or a name inside another word", () => {
    expect(matchEntities("Who is Morwyn?", aliases)).toEqual(["morwyn"]);
    expect(matchEntities("Moiras and Morwyns", aliases)).toEqual([]);
  });

  it("prefers the longer name where names overlap", () => {
    expect(matchEntities("Where is Captain Hale Morrow?", aliases)).toEqual([
      "captain",
    ]);
  });

  it("finds every subject a question names", () => {
    expect(
      matchEntities(
        "How do Morwyn and Moira Vane know each other?",
        aliases,
      ).sort(),
    ).toEqual(["moira", "morwyn"]);
  });

  it("ignores names too short to match safely", () => {
    expect(matchEntities("Al was here", aliases)).toEqual([]);
  });

  it("returns nothing when no subject is named, so /ask reads the whole library", () => {
    expect(matchEntities("What happened last session?", aliases)).toEqual([]);
  });
});

describe("withShortNames", () => {
  it("lets a question use a short name unique to one entity", () => {
    const rows = [
      { entityId: "moira", alias: "Moira Vane" },
      { entityId: "hale", alias: "Captain Hale Morrow" },
      { entityId: "hale2", alias: "Hale Brightwater" },
    ];
    expect(
      matchEntities("what does moira want?", withShortNames(rows)),
    ).toEqual(["moira"]);
    // "Hale" belongs to two people, so it names neither.
    expect(matchEntities("where is hale?", withShortNames(rows))).toEqual([]);
  });
});

describe("wantsBriefing", () => {
  it("is true only when the question asks for the whole picture", () => {
    for (const q of [
      "Tell me everything about the Widow",
      "tell me about Moira Vane",
      "Brief me on House Vane",
      "Give me a rundown on the Gilded Anchor",
      "What do we know about Morwyn?",
      "Who is Morwyn?",
      "What is the Harbour Guild",
      "catch me up on Tobin",
    ])
      expect(wantsBriefing(q), q).toBe(true);
  });

  it("is false for a specific question about someone", () => {
    for (const q of [
      "What is Morwyn's mom's name and how did she die?",
      "Who killed Morwyn's mother?",
      "How much does Moira owe the Harbour Guild?",
      "Where is Tobin now?",
      "Is the Widow working with the Guild, and does Tobin know?",
      "What happened last session?",
    ])
      expect(wantsBriefing(q), q).toBe(false);
  });
});
