import { describe, it, expect } from "vitest";
import { answerNames, buildQuestions } from "./graph-eval.js";

const ent = (id: string, name: string, ...aliases: string[]) => ({
  id,
  name,
  names: [name, ...aliases],
});
const elspeth = ent("e", "Elspeth Vane");
const wren = ent("w", "Wren");
const tobin = ent("t", "Tobin Reed");
const gullRock = ent("g", "Gull Rock");
const guild = ent("h", "Harbour Guild");

describe("buildQuestions", () => {
  const qs = buildQuestions([
    { subject: elspeth, relation: "is mother of", object: wren },
    { subject: elspeth, relation: "lives in", object: gullRock },
    { subject: tobin, relation: "leads", object: guild },
    { subject: tobin, relation: "owes money to", object: guild }, // no template: skipped
  ]);

  it("asks one-hop questions whose answer is the other end", () => {
    expect(
      qs.find((q) => q.question === "Who is Wren's mother?")?.expected,
    ).toEqual([elspeth]);
    expect(
      qs.find((q) => q.question === "Who leads Harbour Guild?")?.expected,
    ).toEqual([tobin]);
    expect(
      qs.find((q) => q.question === "Where does Elspeth Vane live?")?.expected,
    ).toEqual([gullRock]);
  });

  it("asks two-hop questions through a relationship", () => {
    const q = qs.find((x) => x.question === "Where does Wren's mother live?");
    expect(q?.kind).toBe("double");
    expect(q?.expected).toEqual([gullRock]);
  });

  it("skips relationships it has no question for", () => {
    expect(qs).toHaveLength(4);
  });

  it("accepts any recorded answer when there's more than one", () => {
    const two = buildQuestions([
      { subject: elspeth, relation: "is mother of", object: wren },
      { subject: ent("m", "Maren"), relation: "mother of", object: wren },
    ]);
    expect(two[0]!.expected.map((e) => e.id)).toEqual(["e", "m"]);
  });
});

describe("answerNames", () => {
  it("passes an answer that names the expected entity by any name", () => {
    expect(
      answerNames("Her mother was Elspeth Vane.", [elspeth], new Map()),
    ).toBe(true);
    expect(
      answerNames("It was Elspeth.", [elspeth], new Map([["e", ["elspeth"]]])),
    ).toBe(true);
  });

  it("fails an answer that doesn't", () => {
    expect(answerNames("The records don't say.", [elspeth], new Map())).toBe(
      false,
    );
    expect(
      answerNames(
        "Elspethine was there.",
        [elspeth],
        new Map([["e", ["elspeth"]]]),
      ),
    ).toBe(false);
  });
});
