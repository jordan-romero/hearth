import { describe, it, expect } from "vitest";
import {
  factsAbout,
  findMentions,
  mergeEntities,
  nameAppears,
  normalizeName,
  renderEntities,
  verifyEntities,
  verifyRelations,
  windows,
  type GraphEntity,
} from "./graph.js";
import { renderPassages } from "./provenance.js";
import { segmentFor, spansOf } from "./graph-build.js";

// Invented text only.

const doc = renderPassages([
  {
    id: "c0",
    chunkIndex: 0,
    text: "Moira Vane keeps the Gilded Anchor, a tavern on the docks. Folk call her the Widow.",
  },
  {
    id: "c1",
    chunkIndex: 1,
    text: "Morwyn is a hedge witch. She owes Moira Vane forty gold from last winter.",
  },
  { id: "c2", chunkIndex: 2, text: "The harbour is quiet tonight." },
]).index;

const entity = (
  name: string,
  aliases: string[] = [],
  kind = "PERSON",
): GraphEntity => ({
  kind: kind as GraphEntity["kind"],
  name,
  aliases: [name, ...aliases],
  evidence: [],
});

describe("names", () => {
  it("folds case, accents, punctuation and a leading 'the'", () => {
    expect(normalizeName("  The Gilded-Anchor ")).toBe("gilded anchor");
    expect(normalizeName("Móira")).toBe("moira");
  });

  it("keeps similar names apart — Moira is not Morwyn", () => {
    expect(nameAppears(["Moira"], "Morwyn is a hedge witch.")).toBe(false);
    expect(nameAppears(["Moira"], "She owes Moira forty gold.")).toBe(true);
  });

  it("matches whole words only", () => {
    expect(nameAppears(["Ann"], "Annabel waved.")).toBe(false);
  });
});

describe("verifyEntities", () => {
  it("keeps an entity named in its quote, and aliases the document uses", () => {
    const { entities, droppedAliases } = verifyEntities(
      {
        entities: [
          {
            name: "Moira Vane",
            kind: "PERSON",
            aliases: ["the Widow", "the Harbour Queen"],
            passage: "P1",
            quote: "Moira Vane keeps the Gilded Anchor",
          },
        ],
      },
      doc,
    );
    expect(entities).toHaveLength(1);
    expect(entities[0]!.aliases).toEqual(["Moira Vane", "the Widow"]);
    expect(droppedAliases).toBe(1); // "the Harbour Queen" appears nowhere
  });

  it("rejects an entity whose quote doesn't name it", () => {
    const { entities, rejected } = verifyEntities(
      {
        entities: [
          {
            name: "Morwyn",
            kind: "PERSON",
            passage: "P2",
            quote: "owes Moira Vane forty gold",
          },
        ],
      },
      doc,
    );
    expect(entities).toEqual([]);
    expect(rejected["name-not-in-quote"]).toBe(1);
  });

  it("re-attaches a verbatim quote credited to the wrong passage", () => {
    const { entities } = verifyEntities(
      {
        entities: [
          {
            name: "Morwyn",
            kind: "PERSON",
            passage: "P1",
            quote: "Morwyn is a hedge witch",
          },
        ],
      },
      doc,
    );
    expect(entities[0]!.evidence[0]!.passageId).toBe("c1");
  });

  it("rejects words that aren't in the document, and unknown kinds become OTHER", () => {
    const { entities, rejected } = verifyEntities(
      {
        entities: [
          {
            name: "Morwyn",
            kind: "WIZARD",
            passage: "P2",
            quote: "Morwyn is a hedge witch",
          },
          {
            name: "Tobin",
            kind: "PERSON",
            passage: "P2",
            quote: "Tobin rows the ferry",
          },
        ],
      },
      doc,
    );
    expect(entities.map((e) => [e.name, e.kind])).toEqual([
      ["Morwyn", "OTHER"],
    ]);
    expect(rejected["not-in-passage"]).toBe(1);
  });
});

describe("mergeEntities", () => {
  it("merges the same name found twice", () => {
    const { entities } = mergeEntities([
      entity("Moira Vane"),
      entity("moira vane", ["the Widow"]),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.aliases).toEqual(["Moira Vane", "the Widow"]);
  });

  it("merges when one's name is the other's alias", () => {
    const { entities } = mergeEntities([
      entity("Moira Vane", ["the Widow"]),
      entity("The Widow"),
    ]);
    expect(entities).toHaveLength(1);
  });

  it("never merges two people who share only a nickname — drops the nickname instead", () => {
    const { entities, ambiguousAliases } = mergeEntities([
      entity("Captain Hale", ["the Captain"]),
      entity("Captain Orrin", ["the Captain"]),
    ]);
    expect(entities.map((e) => e.aliases)).toEqual([
      ["Captain Hale"],
      ["Captain Orrin"],
    ]);
    expect(ambiguousAliases).toEqual(["captain"]);
  });

  it("keeps Moira and Morwyn separate", () => {
    expect(
      mergeEntities([entity("Moira"), entity("Morwyn")]).entities,
    ).toHaveLength(2);
  });

  it("keeps an existing entity's id when new mentions merge into it", () => {
    const known = { ...entity("Moira Vane"), id: "db-1" } as GraphEntity & {
      id: string;
    };
    const { entities } = mergeEntities([
      known,
      entity("Moira Vane", ["the Widow"]),
    ]);
    expect((entities[0] as GraphEntity & { id?: string }).id).toBe("db-1");
  });
});

describe("verifyRelations", () => {
  const moira = entity("Moira Vane", ["the Widow"]);
  const morwyn = entity("Morwyn");
  const anchor = entity("Gilded Anchor", [], "PLACE");
  const index = renderEntities([moira, morwyn, anchor]).index;

  it("keeps a stated relationship whose passage names both ends, even through a pronoun", () => {
    const { relations } = verifyRelations(
      {
        relations: [
          {
            subject: "E2",
            relation: "Owes money to",
            object: "E1",
            passage: "P2",
            quote: "She owes Moira Vane forty gold",
          },
        ],
      },
      doc,
      index,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]!.relation).toBe("owes money to");
    expect(relations[0]!.subject).toBe(morwyn);
  });

  it("rejects a link the passage doesn't name both ends of", () => {
    const { relations, rejected } = verifyRelations(
      {
        relations: [
          {
            subject: "E2",
            relation: "drinks at",
            object: "E3",
            passage: "P2",
            quote: "She owes Moira Vane forty gold",
          },
        ],
      },
      doc,
      index,
    );
    expect(relations).toEqual([]);
    expect(rejected["ends-not-named"]).toBe(1);
  });

  it("rejects unknown labels and an entity related to itself", () => {
    const { relations, rejected } = verifyRelations(
      {
        relations: [
          {
            subject: "E9",
            relation: "x",
            object: "E1",
            passage: "P1",
            quote: "Moira Vane keeps the Gilded Anchor",
          },
          {
            subject: "E1",
            relation: "is",
            object: "E1",
            passage: "P1",
            quote: "Moira Vane keeps the Gilded Anchor",
          },
        ],
      },
      doc,
      index,
    );
    expect(relations).toEqual([]);
    expect(rejected["unknown-entity"]).toBe(1);
    expect(rejected["self-relation"]).toBe(1);
  });
});

describe("links worked out by code", () => {
  const moira = entity("Moira Vane", ["the Widow"]);
  const morwyn = entity("Morwyn");

  it("finds every passage that mentions an entity by any name", () => {
    const mentions = findMentions([moira, morwyn], [...doc.values()]);
    expect(mentions.get(moira)).toEqual(["c0", "c1"]);
    expect(mentions.get(morwyn)).toEqual(["c1"]);
  });

  it("links a fact to the entities it names", () => {
    const about = factsAbout(
      [moira, morwyn],
      [
        {
          id: "f1",
          title: "The Widow",
          content: "Keeps a tavern on the docks.",
        },
        { id: "f2", title: "Harbour", content: "Quiet at night." },
      ],
    );
    expect(about.get("f1")).toEqual([moira]);
    expect(about.has("f2")).toBe(false);
  });
});

describe("session transcripts as sources", () => {
  const lines = [
    { id: "s1", text: "DM: Moira Vane slides a key across the bar." },
    { id: "s2", text: "Player: I take it." },
    { id: "s3", text: "DM: She says Morwyn sent her." },
  ];

  it("groups lines into spans without splitting a line", () => {
    const spans = spansOf(lines);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.passage.id).toBe("s1");
    expect(spans[0]!.segments.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("attributes a quote to the line that says it", () => {
    expect(segmentFor(lines, "Morwyn sent her")).toBe("s3");
  });

  it("windows a document without losing passages", () => {
    expect(windows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
