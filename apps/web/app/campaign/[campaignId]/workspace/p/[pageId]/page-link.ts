// Links between pages, the way OneNote, Obsidian and Notion do them. Type [[ (or @ after a space)
// to pick a page by name, or create one; type or paste [[Ildin]] and it becomes a link to Ildin's
// page. A link points at the page by id, so renaming the page never breaks it, and it always
// shows the page's current title. A link to a page that doesn't exist yet is dashed; clicking it
// creates the page. After a page's name, # picks one of its headings: [[Ildin#History]].
//
// The node's JSON shape is shared with the server (packages/agents/src/page-links.ts), which
// resolves links on save and keeps the record of what links where.

import {
  InputRule,
  mergeAttributes,
  Node,
  nodePasteRule,
  type Editor,
} from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { findSuggestionMatch } from "@tiptap/suggestion";
import { suggestionPopup } from "./slash";

export interface PageRef {
  id: string;
  title: string;
}

export interface PageLinkOptions {
  /** /campaign/<id>/workspace */
  base: string;
  /** The campaign's pages, read fresh each time (new pages arrive while the editor is open). */
  pages: () => PageRef[];
  /** The page being edited (it changes as pages are opened): not offered as a link to itself. */
  currentPageId: () => string;
  /** Make a page with this title; its id, or null if it couldn't be made. */
  createPage: (title: string) => Promise<string | null>;
  /** A page's headings, if the browser has the page. */
  headings: (pageId: string) => string[];
}

type Pick =
  | { kind: "page"; page: PageRef }
  | { kind: "heading"; page: PageRef; heading: string }
  | { kind: "create"; title: string };

/** Every heading in a page, in order. */
export function headingsOf(doc: {
  type: string;
  content?: unknown[];
}): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; content?: unknown[]; text?: string }) => {
    if (n.type === "heading") {
      const t = (n.content ?? [])
        .map((c) => {
          const node = c as { text?: string; attrs?: { label?: string } };
          return node.text ?? node.attrs?.label ?? "";
        })
        .join("")
        .trim();
      if (t) out.push(t);
      return;
    }
    for (const c of n.content ?? []) walk(c as typeof n);
  };
  walk(doc);
  return out;
}

/** The address of a page, or of a heading in it. */
export function pageHref(
  base: string,
  pageId: string,
  heading?: string | null,
) {
  return `${base}/p/${pageId}${heading ? `#${encodeURIComponent(heading)}` : ""}`;
}

const MAX_PICKS = 8;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Best matches first: exact, then prefix, word prefix, anywhere, then letters in order. With
 * no query, the first `limit` pages as given. */
export function rankPages<T extends PageRef>(
  pages: T[],
  query: string,
  exclude = "",
  limit = MAX_PICKS,
): T[] {
  const q = norm(query);
  const scored: { page: T; score: number }[] = [];
  for (const page of pages) {
    if (page.id === exclude || !page.title.trim()) continue;
    const t = norm(page.title);
    let score = -1;
    if (!q) score = 5;
    else if (t === q) score = 0;
    else if (t.startsWith(q)) score = 1;
    else if (t.split(" ").some((w) => w.startsWith(q))) score = 2;
    else if (t.includes(q)) score = 3;
    else if (isSubsequence(q, t)) score = 4;
    if (score >= 0) scored.push({ page, score });
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.page.title.length - b.page.title.length,
    )
    .slice(0, limit)
    .map((s) => s.page);
}

function isSubsequence(q: string, t: string) {
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length;
}

function picks(options: PageLinkOptions, raw: string): Pick[] {
  const query = raw.replace(/\]+$/, "").trim();
  // "Ildin#Hist": that page's headings.
  const hash = query.indexOf("#");
  if (hash > 0) {
    const page = rankPages(options.pages(), query.slice(0, hash), "", 1)[0];
    if (!page) return [];
    const want = norm(query.slice(hash + 1));
    return options
      .headings(page.id)
      .filter((h) => norm(h).includes(want))
      .slice(0, MAX_PICKS)
      .map((heading): Pick => ({ kind: "heading", page, heading }));
  }
  const pages = rankPages(options.pages(), query, options.currentPageId());
  const exact = pages.some((p) => norm(p.title) === norm(query));
  return [
    ...pages.map((page): Pick => ({ kind: "page", page })),
    ...(query && !exact ? [{ kind: "create" as const, title: query }] : []),
  ];
}

/** The link for a title typed or pasted as [[Title]]: to the one page with that title, or
 * unresolved (dashed, click to create) when there's none. */
function attrsFor(options: PageLinkOptions, typed: string) {
  const [title = "", heading] = typed.split("#").map((s) => s.trim());
  const label = title;
  const matches = options.pages().filter((p) => norm(p.title) === norm(label));
  return {
    ...(matches.length === 1
      ? { pageId: matches[0]!.id, label: matches[0]!.title }
      : { pageId: null, label }),
    heading: heading || null,
  };
}

/** Point the first unresolved link with this label at a page that now exists. */
export function setLinkTarget(editor: Editor, label: string, pageId: string) {
  const { state } = editor;
  let at: number | null = null;
  state.doc.descendants((node, pos) => {
    if (at !== null) return false;
    if (
      node.type.name === "pageLink" &&
      !node.attrs.pageId &&
      node.attrs.label === label
    )
      at = pos;
  });
  if (at === null) return;
  const node = state.doc.nodeAt(at)!;
  editor.view.dispatch(
    state.tr.setNodeMarkup(at, undefined, { ...node.attrs, pageId }),
  );
}

function suggest(
  editor: Editor,
  options: PageLinkOptions,
  char: string,
  key: string,
) {
  return Suggestion<Pick>({
    editor,
    char,
    pluginKey: new PluginKey(key),
    // [[ is closed by ]], so a title with spaces can be typed in full; @ ends at a space.
    allowSpaces: char === "[[",
    allowedPrefixes: char === "[[" ? null : [" "],
    startOfLine: false,
    // A [[ … ]] that's been closed is finished: the input rule turns it into a link, and the
    // picker mustn't run on into the text after it.
    findSuggestionMatch: (trigger) => {
      const match = findSuggestionMatch(trigger);
      return match && /\]\]|\[\[/.test(match.query) ? null : match;
    },
    items: ({ query }) => picks(options, query),
    command: ({ editor: e, range, props }) => {
      const label = props.kind === "create" ? props.title : props.page.title;
      const pageId = props.kind === "create" ? null : props.page.id;
      const heading = props.kind === "heading" ? props.heading : null;
      e.chain()
        .focus()
        .insertContentAt(range, [
          { type: "pageLink", attrs: { pageId, label, heading } },
          { type: "text", text: " " },
        ])
        .run();
      if (props.kind === "create")
        void options.createPage(label).then((id) => {
          if (id) setLinkTarget(e, label, id);
        });
    },
    render: () =>
      suggestionPopup<Pick>({
        label: "Link to a page",
        empty: "Type a page's name",
        show: (p) =>
          p.kind === "page"
            ? { title: p.page.title }
            : p.kind === "heading"
              ? { title: p.heading, hint: `in ${p.page.title}` }
              : {
                  title: `Create “${p.title}”`,
                  hint: "A new page, linked here",
                  className: "create",
                },
      }),
  });
}

export const PageLink = Node.create<PageLinkOptions>({
  name: "pageLink",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addOptions() {
    return {
      base: "",
      pages: () => [],
      currentPageId: () => "",
      createPage: async () => null,
      headings: () => [],
    };
  },

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-link") || null,
        renderHTML: () => ({}),
      },
      label: {
        default: "",
        parseHTML: (el) =>
          el.getAttribute("data-label") ?? el.textContent ?? "",
        renderHTML: () => ({}),
      },
      heading: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-heading") || null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Ahead of the Link mark's a[href], so a copied page link pastes back as one.
    return [{ tag: "a[data-page-link]", priority: 100 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.pageId as string | null;
    const heading = node.attrs.heading as string | null;
    const page = id ? this.options.pages().find((p) => p.id === id) : undefined;
    const name = page?.title || node.attrs.label || "Untitled";
    const text = heading ? `${name} › ${heading}` : name;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-page-link": id ?? "",
        "data-label": node.attrs.label,
        ...(heading ? { "data-heading": heading } : {}),
        class: `ws-pagelink${!id ? " unresolved" : page ? "" : " missing"}`,
        ...(id ? { href: pageHref(this.options.base, id, heading) } : {}),
        title: !id
          ? `No page called “${text}” yet. Click to create it.`
          : page
            ? text
            : "That page is in the trash",
      }),
      text,
    ];
  },

  renderText({ node }) {
    const heading = node.attrs.heading as string | null;
    return `[[${node.attrs.label}${heading ? `#${heading}` : ""}]]`;
  },

  addInputRules() {
    return [
      // Typing the closing ]] swaps the whole [[Title]] for the link. (TipTap's nodeInputRule
      // would keep the brackets around a captured title.)
      new InputRule({
        find: /\[\[([^[\]|\n]+)\]\]$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create(attrsFor(this.options, match[1]!)),
          );
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: /\[\[([^[\]|\n]+)\]\]/g,
        type: this.type,
        getAttributes: (m) => attrsFor(this.options, m[1]!),
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      suggest(this.editor, this.options, "[[", "pageLinkBrackets"),
      suggest(this.editor, this.options, "@", "pageLinkAt"),
    ];
  },
});
