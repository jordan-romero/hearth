import { describe, it, expect } from "vitest";
import { currentFacts, currentPassages } from "./current.js";
import { previousVersionsWhere } from "./upload.js";

const doc = {
  id: "d2",
  campaignId: "camp1",
  name: "NPCS.md",
  createdAt: new Date("2026-09-20T10:00:00Z"),
};

describe("previousVersionsWhere — what a new upload replaces", () => {
  it("takes the same file name in the same campaign, and not itself", () => {
    const where = previousVersionsWhere(doc);
    expect(where.campaignId).toBe("camp1");
    expect(where.name).toBe("NPCS.md");
    expect(where.id).toEqual({ not: "d2" });
  });

  it("leaves a version that was already replaced alone", () => {
    // Otherwise a third upload would re-point the first version at itself, losing the chain.
    expect(previousVersionsWhere(doc).supersededById).toBeNull();
  });

  it("only touches documents uploaded before it", () => {
    // The race guard: two uploads landing together must not mark each other replaced, which
    // would leave the campaign with no current version of the document at all.
    expect(previousVersionsWhere(doc).createdAt).toEqual({
      lt: doc.createdAt,
    });
  });
});

describe("currentFacts / currentPassages — what still counts", () => {
  it("keeps a fact that has no document at all", () => {
    // Session facts, player notes and generated NPCs have no source document. A rule written as
    // "its document isn't replaced" would silently drop every one of them.
    const { AND } = currentFacts({ campaignId: "camp1" });
    const rule = (AND as Record<string, unknown>[])[1]!;
    expect(rule.OR).toEqual([
      { sourceDocumentId: null },
      { sourceDocument: { supersededById: null } },
    ]);
  });

  it("excludes a passage from a replaced document, and a corrected one", () => {
    const { AND } = currentPassages({ campaignId: "camp1" });
    expect((AND as Record<string, unknown>[])[1]).toEqual({
      supersededByCorrectionId: null,
      sourceDocument: { supersededById: null },
    });
  });

  it("doesn't collide with an OR the caller is already using", () => {
    // Merging under AND is the whole reason these are functions: spreading the rule into a where
    // that already has an OR would overwrite the caller's condition and widen the query.
    const callerOr = [{ title: "a" }, { title: "b" }];
    const where = currentFacts({ campaignId: "camp1", OR: callerOr });
    const [caller] = where.AND as Record<string, unknown>[];
    expect(caller!.OR).toBe(callerOr);
  });
});
