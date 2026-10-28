import { describe, it, expect } from "vitest";
import {
  linkedPageIds,
  linkWikiTitles,
  pageLinkNode,
  resolvePageLinks,
} from "./page-links.js";
import { markdownToPage } from "./markdown-to-page.js";
import { pageToMarkdown, type PmNode } from "./page-markdown.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { extractHighlights } from "./highlights.js";

const para = (...content: PmNode[]): PmNode => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});
const text = (t: string, marks?: PmNode["marks"]): PmNode => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});

describe("linkWikiTitles", () => {
  it("turns [[Title]] and [[Title|alias]] into unresolved page links", () => {
    expect(
      linkWikiTitles(
        para(text("Owes [[Ildin]] a debt; see [[Old Mill|the mill]].")),
      ),
    ).toEqual(
      para(
        text("Owes "),
        pageLinkNode(null, "Ildin"),
        text(" a debt; see "),
        pageLinkNode(null, "Old Mill"),
        text("."),
      ),
    );
  });

  it("leaves code, and text without links, untouched", () => {
    const doc = para(text("[[x]]", [{ type: "code" }]), text("no links"));
    expect(linkWikiTitles(doc)).toBe(doc);
  });
});

describe("resolvePageLinks", () => {
  const pages = [
    { id: "p-ildin", title: "Ildin" },
    { id: "p-mill", title: "Old Mill" },
    { id: "p-a", title: "Twin" },
    { id: "p-b", title: "twin" },
  ];

  it("resolves by title, ignoring case and spacing", () => {
    expect(
      resolvePageLinks(para(pageLinkNode(null, "  old   mill ")), pages),
    ).toEqual(para(pageLinkNode("p-mill", "Old Mill")));
  });

  it("keeps a link by id and refreshes its label after a rename", () => {
    expect(
      resolvePageLinks(para(pageLinkNode("p-ildin", "Ildin the Old")), pages),
    ).toEqual(para(pageLinkNode("p-ildin", "Ildin")));
  });

  it("leaves a title it can't pin to one page unresolved", () => {
    const doc = para(pageLinkNode(null, "Twin"), pageLinkNode(null, "Nobody"));
    expect(resolvePageLinks(doc, pages)).toBe(doc);
  });
});

describe("linkedPageIds", () => {
  it("collects page links and ordinary links to this campaign's pages only", () => {
    const doc = para(
      pageLinkNode("p1", "A"),
      pageLinkNode(null, "Nowhere"),
      text("b", [
        { type: "link", attrs: { href: "/campaign/c1/workspace/p/p2?x=1" } },
      ]),
      text("c", [
        {
          type: "link",
          attrs: { href: "https://hearth.test/campaign/c1/workspace/p/p3" },
        },
      ]),
      text("d", [
        { type: "link", attrs: { href: "/campaign/OTHER/workspace/p/p4" } },
      ]),
    );
    expect([...linkedPageIds(doc, "c1")].sort()).toEqual(["p1", "p2", "p3"]);
  });
});

describe("page links in markdown", () => {
  it("round-trips as [[Title]], through bold too", () => {
    const md = "Owes **[[Ildin]]** a debt.";
    const page = markdownToPage(md);
    expect(JSON.stringify(page)).toContain('"pageLink"');
    expect(pageToMarkdown(page)).toBe("Owes [[Ildin]] a debt.");
  });

  it("keeps OneNote's own page links as [[Title]]", () => {
    expect(
      htmlToMarkdown(
        '<p>See <a href="onenote:#Ildin&section-id={x}&end">Ildin</a> and <a href="https://x.test">web</a>.</p>',
      ),
    ).toBe("See [[Ildin]] and [web](https://x.test).");
  });

  it("a highlight over a page link keeps the name", () => {
    const canon = [
      { type: "canon", attrs: { id: "h1", known: [], everyone: true } },
    ];
    expect(
      extractHighlights(
        para(text("Owes ", canon), {
          ...pageLinkNode("p", "Ildin"),
          marks: canon,
        }),
      ),
    ).toEqual([{ id: "h1", text: "Owes Ildin", known: [], everyone: true }]);
  });
});
