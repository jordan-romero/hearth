import { describe, it, expect } from "vitest";
import { extractHighlights, highlightTitle } from "./highlights.js";
import type { PmNode } from "./page-markdown.js";

const canon = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "canon",
  attrs: { id, known: [], everyone: false, ...extra },
});
const t = (text: string, ...marks: PmNode["marks"] & object): PmNode => ({
  type: "text",
  text,
  marks,
});
const p = (...content: PmNode[]): PmNode => ({ type: "paragraph", content });
const doc = (...content: PmNode[]): PmNode => ({ type: "doc", content });

describe("extractHighlights", () => {
  it("finds nothing on a page of working text", () => {
    expect(extractHighlights(doc(p(t("Maybe Vess has a twin?"))))).toEqual([]);
  });

  it("reads each highlight with who knows it", () => {
    const hs = extractHighlights(
      doc(
        p(
          t("A hill cult. "),
          t(
            "Vess meets pilgrims at the Old Mill.",
            canon("h1", { known: ["arvid", "arvid"] }),
          ),
          t(" "),
          t("The stones hum.", canon("h2", { everyone: true })),
        ),
      ),
    );
    expect(hs).toEqual([
      {
        id: "h1",
        text: "Vess meets pilgrims at the Old Mill.",
        known: ["arvid"],
        everyone: false,
      },
      { id: "h2", text: "The stones hum.", known: [], everyone: true },
    ]);
  });

  it("joins one highlight split by other formatting, and across blocks", () => {
    const h = canon("h1");
    const hs = extractHighlights(
      doc(
        p(
          t("Vess is ", h),
          t("the Emperor's", h, { type: "bold" }),
          t(" half-sister.", h),
        ),
        p(t("Exiled after the succession.", h)),
      ),
    );
    expect(hs).toHaveLength(1);
    expect(hs[0]!.text).toBe(
      "Vess is the Emperor's half-sister. … Exiled after the succession.",
    );
  });

  it("finds highlights inside lists and tables", () => {
    const hs = extractHighlights(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(t("Leader: Vess", canon("h1")))] },
        ],
      }),
    );
    expect(hs.map((h) => h.text)).toEqual(["Leader: Vess"]);
  });

  it("ignores a mark without an id, and empty highlights", () => {
    const hs = extractHighlights(
      doc(p(t("no id", { type: "canon", attrs: {} }), t("   ", canon("h2")))),
    );
    expect(hs).toEqual([]);
  });
});

describe("highlightTitle", () => {
  it("keeps short text whole", () => {
    expect(highlightTitle("The stones hum.")).toBe("The stones hum.");
  });
  it("cuts long text on a word", () => {
    const title = highlightTitle(
      "Vess, leader of the Shepherds, is the Emperor's half-sister, exiled after the succession war.",
    );
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title).not.toMatch(/\s…$/);
  });
});
