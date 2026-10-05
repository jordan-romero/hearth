import { describe, it, expect } from "vitest";
import { pageToMarkdown, EMPTY_PAGE, type PmNode } from "./page-markdown.js";

const doc = (...content: PmNode[]): PmNode => ({ type: "doc", content });
const p = (...content: PmNode[]): PmNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]): PmNode => ({
  type: "text",
  text,
  marks: marks.map((type) => ({ type })),
});
const li = (...content: PmNode[]): PmNode => ({ type: "listItem", content });

describe("pageToMarkdown", () => {
  it("is empty for a new page", () => {
    expect(pageToMarkdown(EMPTY_PAGE)).toBe("");
  });

  it("writes headings, paragraphs and inline marks", () => {
    const md = pageToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("The Shepherds")] },
        p(
          t("Led by "),
          t("Vess", "bold"),
          t(", "),
          t("in exile", "italic"),
          t("."),
        ),
      ),
    );
    expect(md).toBe("## The Shepherds\n\nLed by **Vess**, _in exile_.");
  });

  it("writes nested bullet, numbered and task lists", () => {
    const md = pageToMarkdown(
      doc(
        {
          type: "bulletList",
          content: [
            li(p(t("Guards")), {
              type: "bulletList",
              content: [li(p(t("Ilse Marrow")))],
            }),
            li(p(t("Pilgrims"))),
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [li(p(t("Arrive"))), li(p(t("Speak")))],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [p(t("Map"))],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [p(t("Letter"))],
            },
          ],
        },
      ),
    );
    expect(md).toBe(
      "- Guards\n  - Ilse Marrow\n- Pilgrims\n\n1. Arrive\n2. Speak\n\n- [x] Map\n- [ ] Letter",
    );
  });

  it("writes tables, quotes, rules and code", () => {
    const cell = (s: string): PmNode => ({
      type: "tableCell",
      content: [p(t(s))],
    });
    const md = pageToMarkdown(
      doc(
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("Name"), cell("Role")] },
            {
              type: "tableRow",
              content: [cell("Vess"), cell("Leader | exile")],
            },
          ],
        },
        { type: "blockquote", content: [p(t("Kneel."))] },
        { type: "horizontalRule" },
        { type: "codeBlock", content: [t("1d20+4")] },
      ),
    );
    expect(md).toBe(
      "| Name | Role |\n| --- | --- |\n| Vess | Leader \\| exile |\n\n> Kneel.\n\n---\n\n```\n1d20+4\n```",
    );
  });

  it("keeps the text of blocks it doesn't know", () => {
    expect(
      pageToMarkdown(doc({ type: "callout", content: [p(t("Beware"))] })),
    ).toBe("Beware");
  });
});
