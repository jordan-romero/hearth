import { describe, it, expect } from "vitest";
import { decideAudience, narrowestAudience } from "./audience.js";

const present = [
  { id: "c-morwyn", name: "Morwyn Vale" },
  { id: "c-tobin", name: "Tobin" },
  { id: "c-wren", name: "Wren Ashford" },
];

describe("decideAudience", () => {
  it("gives a fact told openly to everyone who was there", () => {
    expect(decideAudience("party", present).sort()).toEqual(
      ["c-morwyn", "c-tobin", "c-wren"].sort(),
    );
  });

  it("gives a private fact to that character alone", () => {
    // The other players heard the whisper out loud; their characters did not.
    expect(decideAudience(["Morwyn Vale"], present)).toEqual(["c-morwyn"]);
  });

  it("matches a character by the name the table actually uses", () => {
    expect(decideAudience(["Morwyn"], present)).toEqual(["c-morwyn"]);
  });

  it("refuses a short name two characters could answer to", () => {
    // "Mor" is Morwyn at this table and ambiguous at one with Moraine — and a wrong guess hands
    // someone else's secret to a player.
    const withMoraine = [...present, { id: "c-moraine", name: "Moraine Vale" }];
    expect(decideAudience(["Mor"], withMoraine)).toEqual([]);
    expect(decideAudience(["Moraine"], withMoraine)).toEqual(["c-moraine"]);
  });

  it("ignores anyone who wasn't at the table", () => {
    // An NPC's name, or a player who missed the session.
    expect(decideAudience(["The Widow", "Tobin"], present)).toEqual([
      "c-tobin",
    ]);
  });

  it("gives a fact to nobody when it can't tell who learned it", () => {
    // DM-only, and the DM can still reveal it. Too narrow is a question; too wide can't be undone.
    expect(decideAudience(undefined, present)).toEqual([]);
    expect(decideAudience([], present)).toEqual([]);
    expect(decideAudience(["nobody in this campaign"], present)).toEqual([]);
  });

  it("never invents a character who wasn't present", () => {
    expect(decideAudience("party", [])).toEqual([]);
    expect(decideAudience(["Morwyn"], [])).toEqual([]);
  });
});

describe("narrowestAudience", () => {
  it("keeps only what every part of the session agrees on", () => {
    // The merged fact holds the private half, so it can only go to whoever learned both.
    expect(
      narrowestAudience([["c-morwyn", "c-tobin", "c-wren"], ["c-morwyn"]]),
    ).toEqual(["c-morwyn"]);
  });

  it("leaves a single part's audience alone", () => {
    expect(narrowestAudience([["c-tobin"]])).toEqual(["c-tobin"]);
  });

  it("is empty when the parts share nobody", () => {
    expect(narrowestAudience([["c-tobin"], ["c-wren"]])).toEqual([]);
  });

  it("is empty when there is nothing to merge", () => {
    expect(narrowestAudience([])).toEqual([]);
  });
});
