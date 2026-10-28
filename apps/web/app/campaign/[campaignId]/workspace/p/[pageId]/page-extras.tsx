"use client";

// The Notion-style extras around a page: an icon (an emoji, shown in the tree and on links),
// templates for what a DM writes most, and callout blocks (a note, a tip, a warning, a DM's
// secret). Callouts read as Obsidian's "> [!note]" in markdown, so imported notes keep them.

import { mergeAttributes, Node as TiptapNode, type Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";

// ─── Callouts ────────────────────────────────────────────────────────────────

export const CALLOUTS = {
  note: { icon: "💡", label: "Note" },
  tip: { icon: "✨", label: "Tip" },
  warning: { icon: "⚠️", label: "Warning" },
  secret: { icon: "🤫", label: "DM secret" },
} as const;
export type CalloutVariant = keyof typeof CALLOUTS;

export const Callout = TiptapNode.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-callout") ?? "note",
        renderHTML: (attrs) => ({ "data-callout": attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const v =
      (node.attrs.variant as CalloutVariant) in CALLOUTS
        ? (node.attrs.variant as CalloutVariant)
        : "note";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: "ws-callout",
        "data-icon": CALLOUTS[v].icon,
      }),
      0,
    ];
  },
});

/** Wrap the current block in a callout (or insert an empty one). */
export function insertCallout(editor: Editor, variant: CalloutVariant) {
  const wrapped = editor.chain().focus().wrapIn("callout", { variant }).run();
  if (!wrapped)
    editor
      .chain()
      .focus()
      .insertContent({
        type: "callout",
        attrs: { variant },
        content: [{ type: "paragraph" }],
      })
      .run();
}

// ─── Templates ───────────────────────────────────────────────────────────────

export interface Template {
  key: string;
  label: string;
  icon: string;
  /** The page's starting content, as HTML the editor reads. */
  html: string;
}

const h = (t: string) => `<h2>${t}</h2>`;
const ul = (...items: string[]) =>
  `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ul>`;
const tasks = (...items: string[]) =>
  `<ul data-type="taskList">${items
    .map(
      (i) => `<li data-type="taskItem" data-checked="false"><p>${i}</p></li>`,
    )
    .join("")}</ul>`;
const secret = (t: string) => `<div data-callout="secret"><p>${t}</p></div>`;

export const TEMPLATES: Template[] = [
  {
    key: "npc",
    label: "NPC",
    icon: "🧙",
    html:
      ul(
        "<strong>Role:</strong> ",
        "<strong>Looks:</strong> ",
        "<strong>Voice &amp; manner:</strong> ",
        "<strong>Wants:</strong> ",
      ) +
      h("What the party knows") +
      "<p></p>" +
      h("Secrets") +
      secret("What they don't know yet.") +
      h("Relationships") +
      ul("Type [[ to link someone, then how they're connected") +
      h("Appearances") +
      "<p></p>",
  },
  {
    key: "location",
    label: "Location",
    icon: "🗺️",
    html:
      h("Overview") +
      "<p></p>" +
      h("Sights, sounds, smells") +
      ul("", "", "") +
      h("Who's here") +
      ul("") +
      h("Secrets &amp; hooks") +
      secret("") +
      h("Connected places") +
      ul(""),
  },
  {
    key: "faction",
    label: "Faction",
    icon: "⚔️",
    html:
      h("Goals") +
      "<p></p>" +
      h("Leaders") +
      ul("") +
      h("Resources") +
      ul("") +
      h("Allies &amp; rivals") +
      ul("") +
      h("If the party does nothing") +
      tasks("", "", "") +
      h("Secrets") +
      secret(""),
  },
  {
    key: "session",
    label: "Session prep",
    icon: "📜",
    html:
      h("Where we left off") +
      "<p></p>" +
      h("Strong start") +
      "<p></p>" +
      h("Possible scenes") +
      tasks("", "", "") +
      h("Secrets &amp; clues") +
      tasks("", "", "", "") +
      h("NPCs &amp; places") +
      ul("Type [[ or @ to link who and where") +
      h("Treasure") +
      ul(""),
  },
];

/** Whether a page is still empty (so a template can fill it). */
export function isEmptyDoc(editor: Editor | null) {
  if (!editor) return false;
  const { doc } = editor.state;
  return (
    doc.childCount === 0 ||
    (doc.childCount === 1 && doc.firstChild!.content.size === 0)
  );
}

/** "Start from: NPC · Location · …" under the title of an empty page. */
export function TemplateChips({ onPick }: { onPick: (t: Template) => void }) {
  return (
    <div
      className="ws-templates"
      role="group"
      aria-label="Start from a template"
    >
      <span className="muted small">Start from</span>
      {TEMPLATES.map((t) => (
        <button
          key={t.key}
          type="button"
          className="ws-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(t)}
        >
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

const ICONS = [
  "🧙",
  "🧝",
  "🧛",
  "🧟",
  "👑",
  "🗡️",
  "⚔️",
  "🛡️",
  "🏹",
  "🪄",
  "📜",
  "📖",
  "🗺️",
  "🧭",
  "🏰",
  "🏯",
  "🏛️",
  "⛪",
  "🏚️",
  "🛖",
  "🌲",
  "⛰️",
  "🌋",
  "🌊",
  "🏝️",
  "🕳️",
  "🐉",
  "🐺",
  "🦅",
  "🕷️",
  "💀",
  "👁️",
  "🔮",
  "💎",
  "💰",
  "🗝️",
  "⚗️",
  "🍺",
  "🔥",
  "❄️",
  "⚡",
  "🌙",
  "☀️",
  "⭐",
  "🎭",
  "🎲",
  "📌",
  "❗",
  "❓",
  "🤫",
];

/** The page's icon, and a small picker to change it. */
export function IconButton({
  icon,
  readOnly,
  onChange,
}: {
  icon: string | null;
  readOnly: boolean;
  onChange: (icon: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node | null)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (readOnly && !icon) return null;
  return (
    <div className="ws-icon-wrap" ref={box}>
      <button
        type="button"
        className={`ws-page-icon${icon ? "" : " empty"}`}
        disabled={readOnly}
        onClick={() => setOpen((o) => !o)}
        title={icon ? "Change the icon" : "Add an icon"}
        aria-label={icon ? "Change the page's icon" : "Add an icon"}
      >
        {icon ?? "☺︎ Add icon"}
      </button>
      {open && (
        <div className="ws-icon-picker" role="dialog" aria-label="Pick an icon">
          <div className="ws-icon-grid">
            {ICONS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onChange(e);
                  setOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>
          {icon && (
            <button
              type="button"
              className="ws-link"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Remove icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}
