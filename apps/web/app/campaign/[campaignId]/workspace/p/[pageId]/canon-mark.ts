// The canon highlight: text the DM has marked as true in the world, colored by who knows it.
// Unmarked text is working prep. The server turns each highlight into knowledge
// (packages/agents/src/highlights.ts) — this file only draws and edits the marks.

import { Mark, mergeAttributes, type Editor } from "@tiptap/core";

export interface HighlightColors {
  table: string;
  characters: Record<string, string>;
}

export interface CanonAttrs {
  id: string | null;
  known: string[];
  everyone: boolean;
}

const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** How a highlight looks: the table's color, one character's, stripes for several, or the
 * neutral "canon, nobody knows yet". */
export function highlightStyle(
  attrs: CanonAttrs,
  colors: HighlightColors,
): string {
  if (attrs.everyone) {
    return `background:${tint(colors.table, 26)};box-shadow:inset 0 -2px 0 ${colors.table}`;
  }
  const known = attrs.known
    .map((id) => colors.characters[id])
    .filter((c): c is string => !!c);
  if (known.length === 0) {
    return "background:var(--canon-unknown);box-shadow:inset 0 -2px 0 var(--canon-unknown-edge)";
  }
  if (known.length === 1) {
    return `background:${tint(known[0]!, 24)};box-shadow:inset 0 -2px 0 ${known[0]}`;
  }
  // Several characters: horizontal bands, one per character.
  const step = 100 / known.length;
  const bands = known
    .map((c, i) => `${tint(c, 30)} ${i * step}% ${(i + 1) * step}%`)
    .join(",");
  return `background:linear-gradient(180deg,${bands});box-shadow:inset 0 -2px 0 ${known[known.length - 1]}`;
}

export function canonMark(colors: HighlightColors) {
  return Mark.create({
    name: "canon",
    // Typing at the end of a highlight doesn't extend it: new text starts as working prep.
    inclusive: false,
    excludes: "canon",
    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-hl"),
          renderHTML: (a) => ({ "data-hl": a.id }),
        },
        known: {
          default: [],
          parseHTML: (el) =>
            (el.getAttribute("data-known") ?? "").split(",").filter(Boolean),
          renderHTML: (a) => ({
            "data-known": ((a.known as string[]) ?? []).join(","),
          }),
        },
        everyone: {
          default: false,
          parseHTML: (el) => el.getAttribute("data-everyone") === "true",
          renderHTML: (a) => ({ "data-everyone": String(!!a.everyone) }),
        },
      };
    },
    parseHTML() {
      return [{ tag: "mark[data-hl]" }];
    },
    renderHTML({ HTMLAttributes, mark }) {
      return [
        "mark",
        mergeAttributes(HTMLAttributes, {
          class: "hl",
          style: highlightStyle(mark.attrs as CanonAttrs, colors),
        }),
        0,
      ];
    },
  });
}

/** The highlight under the cursor or selection, if any. */
export function currentCanon(editor: Editor): CanonAttrs | null {
  if (!editor.isActive("canon")) return null;
  const a = editor.getAttributes("canon") as Partial<CanonAttrs>;
  return { id: a.id ?? null, known: a.known ?? [], everyone: !!a.everyone };
}

/** Mark the selection (or the whole highlight the cursor is in) as canon, known by these. */
export function setCanon(
  editor: Editor,
  next: { known: string[]; everyone: boolean },
): void {
  const current = currentCanon(editor);
  const chain = editor.chain().focus();
  // Inside an existing highlight: change the whole highlight, keeping its id (and so its
  // knowledge and reveals). Otherwise this is a new highlight.
  if (current) chain.extendMarkRange("canon");
  chain
    .setMark("canon", {
      id: current?.id ?? crypto.randomUUID(),
      known: next.everyone ? [] : [...new Set(next.known)],
      everyone: next.everyone,
    })
    .run();
}

/** Back to working prep: remove the highlight. */
export function clearCanon(editor: Editor): void {
  editor.chain().focus().extendMarkRange("canon").unsetMark("canon").run();
}
