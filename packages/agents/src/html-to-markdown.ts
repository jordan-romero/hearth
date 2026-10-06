// HTML → markdown for imports. It only has to carry the structure a DM's notes use (headings,
// nested lists, tables, emphasis, links, quotes) into markdown, which markdown-to-page.ts then
// turns into an editable page. Nothing here is rendered as HTML: markup is read, never trusted,
// and only http(s)/mailto links survive.
//
// Sources: Word documents (via mammoth's HTML) now, OneNote pages next.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x"
          ? parseInt(e.slice(2), 16)
          : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")
    .exec(attrs)
    ?.slice(2)
    .find(Boolean);

export interface HtmlToMarkdownOptions {
  /** Added to every heading level (OneNote uses h1 for the page title, so its body starts at 2). */
  headingOffset?: number;
}

export function htmlToMarkdown(
  html: string,
  opts: HtmlToMarkdownOptions = {},
): string {
  const src = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Finished blocks. `run` groups the items of one top-level list, which join with single
  // newlines; everything else is separated by a blank line.
  const out: { text: string; run: number | null }[] = [];
  let runs = 0;
  let line = ""; // the block being written
  let prefix = ""; // what the current block starts with ("## ", "- ", "> ")
  const lists: { ordered: boolean; n: number }[] = [];
  let quote = 0;
  let pre = false;
  const links: (string | null)[] = [];
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;

  const write = (text: string) => {
    if (cell !== null) cell += text;
    else line += text;
  };
  // Close an emphasis run. Markdown only reads "**x**" as bold when the markers hug the text, so a
  // closing marker goes before any trailing space ("**Ondera **" would stay literal asterisks).
  const close = (marker: string) => {
    const buf = cell !== null ? cell : line;
    const trimmed = buf.replace(/\s+$/, "");
    const next = trimmed + marker + buf.slice(trimmed.length);
    if (cell !== null) cell = next;
    else line = next;
  };
  const emphasis = (marker: string, open: boolean) => {
    if (pre) return;
    if (open) write(marker);
    else close(marker);
  };
  // <span style="font-weight:bold"> and friends: how OneNote (and pasted web text) marks emphasis.
  const spans: string[][] = [];
  const styleMarkers = (attrs: string): string[] => {
    const style = (attr(attrs, "style") ?? "").toLowerCase();
    const out: string[] = [];
    if (/font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(style)) out.push("**");
    if (/font-style\s*:\s*italic/.test(style)) out.push("_");
    if (/text-decoration[^;]*line-through/.test(style)) out.push("~~");
    return out;
  };
  let typedBulletRun: number | null = null; // see below
  const flush = () => {
    let body = line
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
    // Bullets typed (or pasted) as characters rather than made as a list: "• Item", "◦ Sub".
    const typed =
      !prefix && lists.length === 0 ? /^([•◦▪▫‣])\s*(.+)$/s.exec(body) : null;
    if (typed) {
      prefix = typed[1] === "◦" || typed[1] === "▫" ? "  - " : "- ";
      body = typed[2]!;
      if (typedBulletRun === null) typedBulletRun = ++runs;
      out.push({ text: prefix + body, run: typedBulletRun });
      line = "";
      prefix = "";
      return;
    }
    if (body) typedBulletRun = null;
    if (body || prefix.trim().match(/^[-\d]/)) {
      const q = quote ? "> ".repeat(quote) : "";
      out.push({
        text: q + prefix + body,
        run: lists.length > 0 ? runs : null,
      });
    }
    line = "";
    prefix = "";
  };
  const listIndent = () => "  ".repeat(Math.max(lists.length - 1, 0));

  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    const [, closing, rawTag, attrs = "", text] = m;
    if (text !== undefined) {
      const t = decode(text);
      write(pre ? t : t.replace(/\s+/g, " "));
      continue;
    }
    const tag = rawTag!.toLowerCase();
    const open = !closing;

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        flush();
        if (open) {
          const level = Math.min(Number(tag[1]) + (opts.headingOffset ?? 0), 6);
          prefix = `${"#".repeat(level)} `;
        }
        break;
      case "p":
      case "div":
      case "section":
      case "article":
        // Inside a list item a paragraph is just the item's text.
        if (lists.length === 0 && cell === null) flush();
        break;
      case "br":
        write(cell !== null ? " " : "\n");
        break;
      case "hr":
        flush();
        out.push({ text: "---", run: null });
        break;
      case "ul":
      case "ol":
        flush();
        if (open) {
          if (lists.length === 0) runs++;
          lists.push({
            ordered: tag === "ol",
            n: Number(attr(attrs, "start")) || 1,
          });
        } else lists.pop();
        break;
      case "li":
        flush();
        if (open) {
          const list = lists[lists.length - 1];
          const marker = list?.ordered ? `${list.n++}. ` : "- ";
          prefix = listIndent() + marker;
        }
        break;
      case "blockquote":
        flush();
        quote += open ? 1 : -1;
        quote = Math.max(quote, 0);
        break;
      case "pre":
        flush();
        if (open) {
          pre = true;
        } else {
          out.push({
            text: "```\n" + line.replace(/\n+$/, "") + "\n```",
            run: null,
          });
          line = "";
          pre = false;
        }
        break;
      case "strong":
      case "b":
        emphasis("**", open);
        break;
      case "em":
      case "i":
        emphasis("_", open);
        break;
      case "s":
      case "del":
      case "strike":
        emphasis("~~", open);
        break;
      case "span":
        if (open) {
          const markers = pre ? [] : styleMarkers(attrs);
          spans.push(markers);
          for (const m of markers) write(m);
        } else {
          for (const m of (spans.pop() ?? []).reverse()) close(m);
        }
        break;
      case "code":
        if (!pre) write("`");
        break;
      case "a":
        if (open) {
          const href = attr(attrs, "href") ?? "";
          const safe = /^(https?:|mailto:)/i.test(href) ? href : null;
          links.push(safe);
          if (safe) write("[");
        } else {
          const href = links.pop();
          if (href) write(`](${href})`);
        }
        break;
      case "img": {
        const alt = attr(attrs, "alt");
        if (alt) write(` [image: ${decode(alt)}] `);
        break;
      }
      case "table":
        if (open) {
          flush();
          table = [];
        } else if (table) {
          out.push({ text: renderTable(table), run: null });
          table = null;
        }
        break;
      case "tr":
        if (open) row = [];
        else if (row && table) {
          table.push(row);
          row = null;
        }
        break;
      case "td":
      case "th":
        if (open) cell = "";
        else if (cell !== null) {
          row?.push(cell.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"));
          cell = null;
        }
        break;
      default:
        break; // span, font, etc.: their text is enough
    }
  }
  flush();

  return out
    .map(
      (b, i) =>
        (i > 0 && b.run !== null && b.run === out[i - 1]!.run
          ? "\n"
          : i > 0
            ? "\n\n"
            : "") + b.text,
    )
    .join("")
    .replace(/\*\*(\s*)\*\*/g, "$1") // empty bold runs Word leaves behind
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (width === 0) return "";
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [
    line(rows[0]!),
    `|${" --- |".repeat(width)}`,
    ...rows.slice(1).map(line),
  ].join("\n");
}
