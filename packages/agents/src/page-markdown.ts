// A workspace page's editor document (ProseMirror JSON) as markdown — what search, Claude and the
// memory read. Written by hand rather than pulling the editor into the server: the node set is
// small and known (whatever the workspace editor offers), and anything unrecognised still yields
// its text instead of being dropped.

import { inlineText, PAGE_LINK } from "./page-links.js";

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** An empty page, as the editor would create it. */
export const EMPTY_PAGE: PmNode = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function pageToMarkdown(doc: PmNode): string {
  return blocks(doc.content ?? [], "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blocks(nodes: PmNode[], indent: string): string {
  return nodes.map((n) => block(n, indent)).join("\n\n");
}

function block(node: PmNode, indent: string): string {
  const c = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return indent + inline(c);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${indent}${"#".repeat(level)} ${inline(c)}`;
    }
    case "bulletList":
      return c.map((li) => listItem(li, indent, "- ")).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start) || 1;
      return c
        .map((li, i) => listItem(li, indent, `${start + i}. `))
        .join("\n");
    }
    case "taskList":
      return c
        .map((li) =>
          listItem(li, indent, li.attrs?.checked ? "- [x] " : "- [ ] "),
        )
        .join("\n");
    case "blockquote":
      return blocks(c, "")
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    case "codeBlock": {
      const lang =
        typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `${indent}\`\`\`${lang}\n${plain(c)}\n${indent}\`\`\``;
    }
    case "horizontalRule":
      return `${indent}---`;
    case "table":
      return table(c, indent);
    default:
      // Unknown block: keep whatever text it holds.
      return node.content ? blocks(c, indent) : indent + (node.text ?? "");
  }
}

function listItem(item: PmNode, indent: string, marker: string): string {
  const [first, ...rest] = item.content ?? [];
  const head = first ? block(first, "").trimStart() : "";
  const pad = indent + " ".repeat(marker.length);
  const tail = rest.map((n) => block(n, pad)).join("\n");
  return `${indent}${marker}${head}${tail ? `\n${tail}` : ""}`;
}

function table(rows: PmNode[], indent: string): string {
  const cells = rows.map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content ?? [], "")
        .replace(/\n+/g, " ")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (cells.length === 0) return "";
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r: string[]) =>
    `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [
    line(cells[0]!),
    `${indent}|${" --- |".repeat(width)}`,
    ...cells.slice(1).map(line),
  ].join("\n");
}

function plain(nodes: PmNode[]): string {
  return nodes
    .map((n) =>
      n.type === "hardBreak" ? "\n" : (inlineText(n) ?? plain(n.content ?? [])),
    )
    .join("");
}

function inline(nodes: PmNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      // A link to another page reads as the page's name, the way Obsidian writes it.
      if (n.type === PAGE_LINK) return `[[${inlineText(n)}]]`;
      if (n.type !== "text") return n.text ?? inline(n.content ?? []);
      let t = n.text ?? "";
      const marks = new Set((n.marks ?? []).map((m) => m.type));
      if (marks.has("code")) return `\`${t}\``;
      if (marks.has("bold")) t = `**${t}**`;
      if (marks.has("italic")) t = `_${t}_`;
      if (marks.has("strike")) t = `~~${t}~~`;
      const link = n.marks?.find((m) => m.type === "link");
      if (typeof link?.attrs?.href === "string")
        t = `[${t}](${link.attrs.href})`;
      return t;
    })
    .join("");
}
