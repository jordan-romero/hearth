import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { markdownToPage, textToPage } from "./markdown-to-page.js";
import { pageToMarkdown } from "./page-markdown.js";

describe("htmlToMarkdown", () => {
  it("keeps headings, paragraphs, emphasis and links", () => {
    expect(
      htmlToMarkdown(
        '<h1>The Shepherds</h1><p>A <strong>hill</strong> cult, led by <em>Vess</em>. See <a href="https://x.test/a">notes</a>.</p>',
      ),
    ).toBe(
      "# The Shepherds\n\nA **hill** cult, led by _Vess_. See [notes](https://x.test/a).",
    );
  });

  it("shifts headings when asked (OneNote's title is h1)", () => {
    expect(htmlToMarkdown("<h1>Body</h1>", { headingOffset: 1 })).toBe(
      "## Body",
    );
  });

  it("keeps nested and numbered lists", () => {
    expect(
      htmlToMarkdown(
        "<ul><li>Guards<ul><li>Ilse Marrow</li></ul></li><li>Pilgrims</li></ul><ol><li>Arrive</li><li>Speak</li></ol>",
      ),
    ).toBe("- Guards\n  - Ilse Marrow\n- Pilgrims\n\n1. Arrive\n2. Speak");
  });

  it("turns typed bullets into a real list", () => {
    expect(
      htmlToMarkdown(
        "<p>Beats</p><p>\t•\tMention the drought</p><p>\t•\tThank the guard</p><p>\t◦\tCaptain Ilse</p><p>After.</p>",
      ),
    ).toBe(
      "Beats\n\n- Mention the drought\n- Thank the guard\n  - Captain Ilse\n\nAfter.",
    );
  });

  it("turns tables into markdown tables", () => {
    expect(
      htmlToMarkdown(
        "<table><tr><th>Name</th><th>Role</th></tr><tr><td>Vess</td><td>Leader | exile</td></tr></table>",
      ),
    ).toBe("| Name | Role |\n| --- | --- |\n| Vess | Leader \\| exile |");
  });

  it("drops unsafe links and markup, keeps the words", () => {
    expect(
      htmlToMarkdown(
        '<p><a href="javascript:alert(1)">click</a> <script>bad()</script><span style="x">ok</span></p>',
      ),
    ).toBe("click ok");
  });

  it("decodes entities and keeps image alt text", () => {
    expect(
      htmlToMarkdown(
        '<p>Tom &amp; Jerry&#39;s &lt;inn&gt; <img src="a.png" alt="Map of Ondera"></p>',
      ),
    ).toBe("Tom & Jerry's <inn> [image: Map of Ondera]");
  });
});

describe("markdownToPage", () => {
  it("round-trips the structure DMs write", () => {
    const md = [
      "# The Shepherds",
      "",
      "A **hill** cult, led by _Vess_. See [notes](https://x.test/a).",
      "",
      "- Guards",
      "  - Ilse Marrow",
      "- Pilgrims",
      "",
      "1. Arrive",
      "2. Speak",
      "",
      "- [x] Map",
      "- [ ] Letter",
      "",
      "> Kneel.",
      "",
      "---",
      "",
      "| Name | Role |",
      "| --- | --- |",
      "| Vess | Leader |",
      "",
      "```",
      "1d20+4",
      "```",
    ].join("\n");
    expect(pageToMarkdown(markdownToPage(md))).toBe(md);
  });

  it("never keeps a script link", () => {
    const page = markdownToPage("[x](javascript:alert(1))");
    expect(JSON.stringify(page)).not.toContain("javascript");
    expect(pageToMarkdown(page)).toBe("x");
  });

  it("keeps characters markdown escapes", () => {
    expect(pageToMarkdown(markdownToPage("Tom & Jerry's <inn>"))).toBe(
      "Tom & Jerry's",
    );
  });

  it("gives an empty file an empty page", () => {
    expect(markdownToPage("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });
});

describe("textToPage", () => {
  it("makes a paragraph per block and keeps line breaks", () => {
    expect(pageToMarkdown(textToPage("Line one\nline two\n\nNext para"))).toBe(
      "Line one  \nline two\n\nNext para",
    );
  });
});
