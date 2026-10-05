// Markdown → a workspace page (the editor's ProseMirror JSON). The inverse of page-markdown.ts,
// used when importing: a DM's .md notes arrive as real headings, lists, tables and checklists
// they can keep editing, not as one block of text.
//
// Parsed with marked's lexer (tokens only — no HTML is produced or trusted), then mapped onto
// the node types the workspace editor understands. Anything without an equivalent keeps its
// text as a paragraph.

import { Lexer, type Token, type Tokens } from "marked";
import type { PmNode } from "./page-markdown.js";

type Mark = { type: string; attrs?: Record<string, unknown> };

export function markdownToPage(markdown: string): PmNode {
  const tokens = new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, "\n"));
  const content = blocks(tokens);
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

/** Plain text → a page: one paragraph per blank-line-separated block, line breaks kept. */
export function textToPage(text: string): PmNode {
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): PmNode => {
      const lines = p.split("\n");
      const inline: PmNode[] = [];
      lines.forEach((line, i) => {
        if (i > 0) inline.push({ type: "hardBreak" });
        if (line) inline.push({ type: "text", text: line });
      });
      return { type: "paragraph", content: inline };
    });
  return {
    type: "doc",
    content: paras.length ? paras : [{ type: "paragraph" }],
  };
}

function paragraph(inline: PmNode[]): PmNode {
  return inline.length
    ? { type: "paragraph", content: inline }
    : { type: "paragraph" };
}

function blocks(tokens: Token[]): PmNode[] {
  const out: PmNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({
          type: "heading",
          attrs: { level: Math.min(Math.max(h.depth, 1), 6) },
          content: inlines(h.tokens),
        });
        break;
      }
      case "paragraph":
        out.push(paragraph(inlines((t as Tokens.Paragraph).tokens)));
        break;
      case "text": {
        const x = t as Tokens.Text;
        out.push(
          paragraph(x.tokens ? inlines(x.tokens) : textNodes(x.text, [])),
        );
        break;
      }
      case "list":
        out.push(list(t as Tokens.List));
        break;
      case "blockquote": {
        const inner = blocks((t as Tokens.Blockquote).tokens);
        out.push({
          type: "blockquote",
          content: inner.length ? inner : [paragraph([])],
        });
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        out.push({
          type: "codeBlock",
          attrs: { language: c.lang || null },
          ...(c.text ? { content: [{ type: "text", text: c.text }] } : {}),
        });
        break;
      }
      case "hr":
        out.push({ type: "horizontalRule" });
        break;
      case "table":
        out.push(table(t as Tokens.Table));
        break;
      default: {
        // html, def, and anything newer: keep the visible text, never the markup.
        const raw = "text" in t && typeof t.text === "string" ? t.text : t.raw;
        const text = raw.replace(/<[^>]+>/g, "").trim();
        if (text) out.push(paragraph(textNodes(text, [])));
      }
    }
  }
  return out;
}

function list(l: Tokens.List): PmNode {
  const isTask = l.items.some((i) => i.task);
  const items = l.items.map((item): PmNode => {
    let inner = blocks(item.tokens.filter((tok) => tok.type !== "checkbox"));
    if (inner.length === 0 || inner[0]!.type !== "paragraph")
      inner = [paragraph([]), ...inner];
    return isTask
      ? { type: "taskItem", attrs: { checked: !!item.checked }, content: inner }
      : { type: "listItem", content: inner };
  });
  if (isTask) return { type: "taskList", content: items };
  return l.ordered
    ? {
        type: "orderedList",
        attrs: { start: typeof l.start === "number" ? l.start : 1 },
        content: items,
      }
    : { type: "bulletList", content: items };
}

function table(t: Tokens.Table): PmNode {
  const cell = (type: string, c: Tokens.TableCell): PmNode => ({
    type,
    content: [paragraph(inlines(c.tokens))],
  });
  return {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: t.header.map((c) => cell("tableHeader", c)),
      },
      ...t.rows.map((row) => ({
        type: "tableRow",
        content: row.map((c) => cell("tableCell", c)),
      })),
    ],
  };
}

function textNodes(text: string, marks: Mark[]): PmNode[] {
  if (!text) return [];
  return [{ type: "text", text, ...(marks.length ? { marks } : {}) }];
}

function inlines(tokens: Token[] | undefined, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const x = t as Tokens.Text;
        out.push(
          ...(x.tokens?.length
            ? inlines(x.tokens, marks)
            : textNodes(decode(x.text), marks)),
        );
        break;
      }
      case "escape":
        out.push(...textNodes((t as Tokens.Escape).text, marks));
        break;
      case "strong":
        out.push(
          ...inlines((t as Tokens.Strong).tokens, [...marks, { type: "bold" }]),
        );
        break;
      case "em":
        out.push(
          ...inlines((t as Tokens.Em).tokens, [...marks, { type: "italic" }]),
        );
        break;
      case "del":
        out.push(
          ...inlines((t as Tokens.Del).tokens, [...marks, { type: "strike" }]),
        );
        break;
      case "codespan":
        out.push(
          ...textNodes(decode((t as Tokens.Codespan).text), [
            ...marks,
            { type: "code" },
          ]),
        );
        break;
      case "link": {
        const l = t as Tokens.Link;
        // Only web and mail links survive; anything else (javascript:, data:) becomes plain text.
        const safe = /^(https?:|mailto:)/i.test(l.href);
        out.push(
          ...inlines(
            l.tokens,
            safe
              ? [...marks, { type: "link", attrs: { href: l.href } }]
              : marks,
          ),
        );
        break;
      }
      case "image": {
        const alt = (t as Tokens.Image).text;
        if (alt) out.push(...textNodes(`[image: ${alt}]`, marks));
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      default: {
        const raw = "text" in t && typeof t.text === "string" ? t.text : t.raw;
        out.push(...textNodes(raw.replace(/<[^>]+>/g, ""), marks));
      }
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

// marked hands back text with &, <, > escaped; pages hold the characters themselves.
function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()]!;
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x"
          ? parseInt(e.slice(2), 16)
          : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}
