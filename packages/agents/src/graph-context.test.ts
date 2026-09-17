import { describe, it, expect } from "vitest";
import { matchEntities } from "./graph-context.js";

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
