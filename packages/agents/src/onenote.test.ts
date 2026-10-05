import { describe, it, expect } from "vitest";
import { oneNoteHtmlToMarkdown } from "./onenote.js";

describe("oneNoteHtmlToMarkdown", () => {
  it("keeps headings, paragraphs and lists; drops the head and title", () => {
    const html = `<html><head><title>Ondera</title><style>p{}</style></head>
      <body><div style="position:absolute"><h1>The Shepherds</h1>
      <p>A cult in the <b>hills</b>.</p><ul><li>Leader: Vess</li><li>Seat: Old Mill</li></ul></div></body></html>`;
    expect(oneNoteHtmlToMarkdown(html)).toBe(
      "## The Shepherds\n\nA cult in the hills.\n\n- Leader: Vess\n- Seat: Old Mill",
    );
  });

  it("decodes entities", () => {
    expect(
      oneNoteHtmlToMarkdown(
        "<p>Tom &amp; Jerry&#39;s &lt;inn&gt;&nbsp;&#x2014;</p>",
      ),
    ).toBe("Tom & Jerry's <inn> —");
  });

  it("turns table rows into lines of cells", () => {
    const html =
      "<table><tr><td>Name</td><td>Role</td></tr><tr><td>Vess</td><td>Leader</td></tr></table>";
    expect(oneNoteHtmlToMarkdown(html)).toBe("Name | Role\nVess | Leader");
  });

  it("keeps an image's alt text, since the pixels can't be read", () => {
    expect(
      oneNoteHtmlToMarkdown('<p><img src="x" alt="Map of Ondera" /></p>'),
    ).toBe("[image: Map of Ondera]");
  });

  it("returns nothing for an empty page", () => {
    expect(
      oneNoteHtmlToMarkdown(
        "<html><head><title>T</title></head><body><div></div></body></html>",
      ),
    ).toBe("");
  });
});
