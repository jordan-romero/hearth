import { describe, it, expect } from "vitest";
import {
  extractionWindows,
  mergeDocUnits,
  type ExtractedDocUnit,
} from "./extract.js";
import { nextSessionNumber } from "./session-number.js";

describe("extractionWindows — reading a long document in sections", () => {
  it("keeps a short document in one window", () => {
    expect(extractionWindows("Toven runs a tavern.\n\nDerkath too.")).toEqual([
      "Toven runs a tavern.\n\nDerkath too.",
    ]);
  });

  it("returns nothing for an empty document", () => {
    expect(extractionWindows("   \n\n  ")).toEqual([]);
  });

  it("splits at paragraph edges and loses no paragraph", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} ${"x".repeat(80)}`,
    );
    const windows = extractionWindows(paragraphs.join("\n\n"), 300);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(300);
    expect(windows.join("\n\n")).toBe(paragraphs.join("\n\n"));
  });

  it("breaks up one huge paragraph instead of sending it whole", () => {
    const wall = Array.from(
      { length: 40 },
      (_, i) => `Fact ${i} is true.`,
    ).join(" ");
    const windows = extractionWindows(wall, 120);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(120);
  });
});

describe("mergeDocUnits — facts about the same subject from different sections", () => {
  const npc = (over: Partial<ExtractedDocUnit>): ExtractedDocUnit => ({
    type: "NPC",
    title: "Kalumi",
    content: "A healer from Varrow.",
    ...over,
  });

  it("merges the same subject regardless of case and punctuation", () => {
    const merged = mergeDocUnits([
      npc({}),
      npc({ title: "kalumi!", content: "Raised Morwyn's sister." }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe(
      "A healer from Varrow. Raised Morwyn's sister.",
    );
  });

  it("doesn't repeat content a later section says again", () => {
    const merged = mergeDocUnits([
      npc({}),
      npc({ content: "A healer from Varrow." }),
    ]);
    expect(merged[0]!.content).toBe("A healer from Varrow.");
  });

  it("keeps secrets from any section, and only when there is one", () => {
    const merged = mergeDocUnits([
      npc({}),
      npc({ content: "Tends the shrine.", secret: "Informs for the cult." }),
      { type: "LOCATION", title: "Varrow", content: "A river town." },
    ]);
    expect(merged.find((u) => u.title === "Kalumi")!.secret).toBe(
      "Informs for the cult.",
    );
    expect(merged.find((u) => u.title === "Varrow")!.secret).toBeUndefined();
  });

  it("keeps the first type and the original order", () => {
    const merged = mergeDocUnits([
      npc({}),
      { type: "LOCATION", title: "Varrow", content: "A river town." },
      npc({ type: "FACT", content: "Owes a debt." }),
    ]);
    expect(merged.map((u) => u.title)).toEqual(["Kalumi", "Varrow"]);
    expect(merged[0]!.type).toBe("NPC");
  });

  it("drops a fact with no usable title", () => {
    expect(mergeDocUnits([npc({ title: "!!!" })])).toEqual([]);
  });
});

describe("nextSessionNumber — joining a campaign mid-way", () => {
  it("starts a new campaign at 1", () => {
    expect(nextSessionNumber(null, 1)).toBe(1);
  });

  it("starts where an already-running campaign is", () => {
    expect(nextSessionNumber(null, 23)).toBe(23);
  });

  it("follows the latest recorded session once there is one", () => {
    expect(nextSessionNumber(23, 23)).toBe(24);
    expect(nextSessionNumber(4, 23)).toBe(5);
  });

  it("never numbers a session below 1", () => {
    expect(nextSessionNumber(null, 0)).toBe(1);
    expect(nextSessionNumber(null, -5)).toBe(1);
  });
});
