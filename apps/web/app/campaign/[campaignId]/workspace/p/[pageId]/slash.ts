// The "/" menu: type / at the start of a line (or after a space) and pick a block. Filter by
// typing, move with ↑↓, choose with Enter, close with Escape.

import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, {
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";

interface Item {
  title: string;
  hint: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

const ITEMS: Item[] = [
  {
    title: "Text",
    hint: "Plain paragraph",
    keywords: "paragraph p",
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: "Heading",
    hint: "Large section heading",
    keywords: "h1 h2 title",
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    title: "Subheading",
    hint: "Smaller heading",
    keywords: "h3",
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    hint: "- item",
    keywords: "ul bullet",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "1. item",
    keywords: "ol ordered",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Checklist",
    hint: "[ ] to do",
    keywords: "todo task check",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    hint: "Read-aloud text, a letter",
    keywords: "blockquote speech",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Table",
    hint: "Rows and columns",
    keywords: "grid stats",
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: "Divider",
    hint: "A line across the page",
    keywords: "hr rule separator",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    title: "Code",
    hint: "Monospace block",
    keywords: "pre",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
];

function filter(query: string): Item[] {
  const q = query.toLowerCase().trim();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (i) => i.title.toLowerCase().includes(q) || i.keywords.includes(q),
  );
}

/** A small DOM popup; kept framework-free so it can live inside the editor's plugin lifecycle. */
function popup() {
  let el: HTMLDivElement | null = null;
  let items: Item[] = [];
  let index = 0;
  let props: SuggestionProps<Item> | null = null;

  const draw = () => {
    if (!el) return;
    el.replaceChildren();
    if (items.length === 0) {
      const none = document.createElement("div");
      none.className = "ws-slash-empty";
      none.textContent = "No matching block";
      el.append(none);
      return;
    }
    items.forEach((item, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ws-slash-item${i === index ? " on" : ""}`;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(i === index));
      const t = document.createElement("span");
      t.textContent = item.title;
      const h = document.createElement("small");
      h.textContent = item.hint;
      b.append(t, h);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        props?.command(item);
      });
      el!.append(b);
    });
  };

  const place = async () => {
    const rect = props?.clientRect?.();
    if (!el || !rect) return;
    const virtual = { getBoundingClientRect: () => rect };
    const { x, y } = await computePosition(virtual, el, {
      placement: "bottom-start",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    });
    Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  };

  return {
    onStart(p: SuggestionProps<Item>) {
      props = p;
      items = p.items;
      index = 0;
      el = document.createElement("div");
      el.className = "ws-slash";
      el.setAttribute("role", "listbox");
      el.setAttribute("aria-label", "Insert a block");
      document.body.append(el);
      draw();
      void place();
    },
    onUpdate(p: SuggestionProps<Item>) {
      props = p;
      items = p.items;
      index = Math.min(index, Math.max(items.length - 1, 0));
      draw();
      void place();
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === "ArrowDown") {
        index = (index + 1) % Math.max(items.length, 1);
        draw();
        return true;
      }
      if (event.key === "ArrowUp") {
        index = (index - 1 + items.length) % Math.max(items.length, 1);
        draw();
        return true;
      }
      if (event.key === "Enter") {
        const item = items[index];
        if (item) props?.command(item);
        return true;
      }
      return false; // Escape is handled by the suggestion plugin, which then calls onExit
    },
    onExit() {
      el?.remove();
      el = null;
      props = null;
    },
  };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<Item>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => filter(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popup,
      }),
    ];
  },
});
