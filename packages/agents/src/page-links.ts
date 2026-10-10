// Links between workspace pages (docs/notes-feel.md §2.2). A page link is an inline node,
// { type: "pageLink", attrs: { pageId, label } }: it points at the page by id, so renaming a page
// never breaks it, and `label` is the page's title as last seen (kept current on save, and what
// shows if the page is gone). `pageId: null` is a link not yet resolved: "[[Ildin]]" before
// there's an Ildin, or text that just arrived from an import, a paste or Claude.
//
// Pure: no database. The workspace service resolves links on save and records what links where.

import type { PmNode } from "./page-markdown.js";

export const PAGE_LINK = "pageLink";

/** "[[Ildin]]", or "[[Ildin|the ferryman]]" (Obsidian's alias form: the title is what links). */
const WIKI = /\[\[([^[\]|\n]+)(?:\|[^[\]\n]*)?\]\]/g;

export function pageLinkNode(pageId: string | null, label: string): PmNode {
  return { type: PAGE_LINK, attrs: { pageId, label } };
}

/** The words an inline node stands for: a text node's text, a page link's label. */
export function inlineText(node: PmNode): string | undefined {
  if (node.type === PAGE_LINK) return labelOf(node);
  return node.text;
}

function labelOf(node: PmNode): string {
  return typeof node.attrs?.label === "string" ? node.attrs.label : "";
}

function idOf(node: PmNode): string | null {
  return typeof node.attrs?.pageId === "string" && node.attrs.pageId
    ? node.attrs.pageId
    : null;
}

/** Turn every literal "[[Title]]" in the page's text into an unresolved page link. Code (inline
 * code and code blocks) is left alone. */
export function linkWikiTitles(doc: PmNode): PmNode {
  const walk = (node: PmNode): PmNode => {
    if (node.type === "codeBlock" || !node.content) return node;
    let changed = false;
    const content: PmNode[] = [];
    for (const child of node.content) {
      if (
        child.type === "text" &&
        child.text?.includes("[[") &&
        !child.marks?.some((m) => m.type === "code")
      ) {
        const parts = splitWiki(child);
        if (parts.length !== 1 || parts[0] !== child) changed = true;
        content.push(...parts);
      } else {
        const next = walk(child);
        if (next !== child) changed = true;
        content.push(next);
      }
    }
    return changed ? { ...node, content } : node;
  };
  return walk(doc);
}

function splitWiki(text: PmNode): PmNode[] {
  const s = text.text ?? "";
  const out: PmNode[] = [];
  let last = 0;
  for (const m of s.matchAll(WIKI)) {
    const title = m[1]!.trim();
    if (!title) continue;
    if (m.index! > last) out.push({ ...text, text: s.slice(last, m.index) });
    out.push({
      ...pageLinkNode(null, title),
      ...(text.marks?.length ? { marks: text.marks } : {}),
    });
    last = m.index! + m[0].length;
  }
  if (last === 0) return [text];
  if (last < s.length) out.push({ ...text, text: s.slice(last) });
  return out;
}

const normalTitle = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Bring every page link up to date against the campaign's pages: a link to a page keeps its id
 * and takes the page's current title as its label; an unresolved link takes the id of the page
 * with that title (case-insensitive), if there is exactly one. Returns the same object when
 * nothing changed.
 */
export function resolvePageLinks(
  doc: PmNode,
  pages: readonly { id: string; title: string }[],
): PmNode {
  const titleById = new Map(pages.map((p) => [p.id, p.title]));
  const idsByTitle = new Map<string, string[]>();
  for (const p of pages) {
    const key = normalTitle(p.title);
    if (!key) continue;
    idsByTitle.set(key, [...(idsByTitle.get(key) ?? []), p.id]);
  }

  const walk = (node: PmNode): PmNode => {
    if (node.type === PAGE_LINK) {
      const id = idOf(node);
      if (id) {
        const title = titleById.get(id);
        return title && title !== labelOf(node)
          ? { ...node, attrs: { ...node.attrs, label: title } }
          : node;
      }
      const matches = idsByTitle.get(normalTitle(labelOf(node)));
      return matches?.length === 1
        ? {
            ...node,
            attrs: {
              ...node.attrs,
              pageId: matches[0],
              label: titleById.get(matches[0]!),
            },
          }
        : node;
    }
    if (!node.content) return node;
    let changed = false;
    const content = node.content.map((c) => {
      const next = walk(c);
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...node, content } : node;
  };
  return walk(doc);
}

/**
 * Every page this one links to: page links, and ordinary links whose address is a page in this
 * campaign's workspace (/campaign/<id>/workspace/p/<pageId>).
 */
export function linkedPageIds(doc: PmNode, campaignId: string): Set<string> {
  const ids = new Set<string>();
  const prefix = `/campaign/${campaignId}/workspace/p/`;
  const walk = (node: PmNode) => {
    if (node.type === PAGE_LINK) {
      const id = idOf(node);
      if (id) ids.add(id);
    }
    for (const m of node.marks ?? []) {
      const href = m.type === "link" ? m.attrs?.href : null;
      if (typeof href !== "string") continue;
      const path = href.replace(/^https?:\/\/[^/]+/i, "");
      if (path.startsWith(prefix)) {
        const id = path.slice(prefix.length).split(/[/?#]/)[0];
        if (id) ids.add(id);
      }
    }
    for (const c of node.content ?? []) walk(c);
  };
  walk(doc);
  return ids;
}

/** Whether a page has any links worth resolving or recording, or [[text]] that could become one
 * (a cheap check before a query). */
export function mayHaveLinks(doc: PmNode): boolean {
  const s = JSON.stringify(doc);
  return (
    s.includes(`"${PAGE_LINK}"`) ||
    s.includes("/workspace/p/") ||
    s.includes("[[")
  );
}
