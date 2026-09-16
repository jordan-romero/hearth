// Where a piece begins and ends.
//
// Revealing one passage hands over a slice: chunks are ~1500 characters cut at a paragraph edge,
// so "the session 81 recap" arrives as whatever fraction happened to match. Revealing the whole
// document releases everything — a session log can hold a hundred sessions. Neither is what the
// DM meant; they meant the recap, the NPC's entry, the description of the place.
//
// So a reveal covers a SECTION: the run of passages from one heading to the next.
//
// The subtlety, learned from the real campaign rather than guessed at: a heading is almost never
// at the START of a passage. The chunker breaks on paragraph boundaries at a target size, so
// headings land in the middle of passages. Looking only at a passage's first line found four
// boundaries in a document containing a hundred and eleven sessions. A passage therefore opens a
// section when it CONTAINS a heading anywhere in it.
//
// The cost of that: passage boundaries and heading boundaries don't line up, so a revealed
// section can carry a little of its neighbours at the edges — grants are per passage, and a
// passage holding two headings belongs to both sections. Erring toward slightly more context is
// the right direction: the DM sees the size before releasing it, and the failure being fixed was
// a recap arriving as a fragment.
//
// Pure: no I/O, so the boundary rules are tested directly.

/** A passage as this module needs it: its place in the document and its text. */
export interface SectionPassage {
  chunkIndex: number;
  text: string;
}

/**
 * Is this single line a heading — the start of a new piece?
 *
 * Deliberately narrow. A false positive splits a piece and the DM reveals half a recap, which is
 * the bug this exists to fix, so only unambiguous headings count: markdown headings, a line
 * announcing a numbered session or chapter, and a short line with its own underline. A bare rule
 * ("-----") is not a heading on its own — the real campaign's session log is full of them as
 * decoration, and treating each as a boundary would shred every recap.
 */
export function isHeadingLine(line: string, next?: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^#{1,6}\s+\S/.test(text)) return true;
  if (
    /^(?:#{1,6}\s*)?(session|chapter|episode|part)\s*#?\s*\d{1,4}\b/i.test(text)
  )
    return true;
  // Setext: a short title on its own line, underlined beneath.
  if (
    next !== undefined &&
    /^[=-]{3,}$/.test(next.trim()) &&
    text.length <= 120
  )
    return true;
  return false;
}

/** The heading lines inside a passage, in order. Empty when it holds none. */
export function headingsIn(text: string): string[] {
  const lines = text.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isHeadingLine(lines[i]!, lines[i + 1])) found.push(lines[i]!.trim());
  }
  return found;
}

/** Does this passage open a new section — i.e. does a heading appear anywhere in it? */
export function opensSection(text: string): boolean {
  return headingsIn(text).length > 0;
}

/**
 * The span of passages forming the section containing `anchorIndex`.
 *
 * Walks back to the nearest passage containing a heading (or the start of the document) and
 * forward to the one before the next passage that contains a heading (or the end). Returns
 * inclusive indices into `passages`, which must be the document's passages in order.
 */
export function sectionRange(
  passages: SectionPassage[],
  anchorIndex: number,
): { from: number; to: number } {
  if (passages.length === 0) return { from: 0, to: -1 };
  const anchor = Math.max(0, Math.min(anchorIndex, passages.length - 1));

  let from = anchor;
  while (from > 0 && !opensSection(passages[from]!.text)) from -= 1;

  let to = anchor;
  while (to + 1 < passages.length && !opensSection(passages[to + 1]!.text)) {
    to += 1;
  }
  return { from, to };
}

/**
 * The passages of the section containing the passage at `anchorChunkIndex`.
 *
 * `passages` is the whole document, in any order — it is sorted here, so a caller can hand over
 * rows straight from the database.
 */
export function sectionFor<T extends SectionPassage>(
  passages: T[],
  anchorChunkIndex: number,
): T[] {
  const ordered = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const anchor = ordered.findIndex((p) => p.chunkIndex === anchorChunkIndex);
  if (anchor === -1) return [];
  const { from, to } = sectionRange(ordered, anchor);
  return ordered.slice(from, to + 1);
}

/**
 * A section's text as one piece.
 *
 * Consecutive chunks share an overlap (the chunker carries 200 characters into the next one), so
 * joining them naively repeats a sentence or two at every seam. The repeated text is trimmed by
 * finding the longest suffix of what has been written so far that the next passage begins with.
 */
export function joinPassages(passages: SectionPassage[]): string {
  const ordered = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  let joined = "";
  for (const passage of ordered) {
    const text = passage.text.trim();
    if (!joined) {
      joined = text;
      continue;
    }
    // Longest overlap first: a short coincidental match would leave the seam duplicated.
    const max = Math.min(joined.length, text.length, 400);
    let overlap = 0;
    for (let size = max; size > 20; size -= 1) {
      if (joined.endsWith(text.slice(0, size))) {
        overlap = size;
        break;
      }
    }
    joined += overlap > 0 ? text.slice(overlap) : `\n\n${text}`;
  }
  return joined;
}

/**
 * What to call this section: its first heading, cleaned of the markup that marks it as one.
 *
 * Falls back to the document's name, because an untitled section still has to be named on the
 * button the DM is about to press.
 */
export function sectionTitle(
  passages: SectionPassage[],
  fallback: string,
): string {
  const ordered = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const heading = ordered.flatMap((p) => headingsIn(p.text))[0];
  if (!heading) return fallback;
  const cleaned = heading.replace(/^#{1,6}\s+/, "").trim();
  return cleaned || fallback;
}

/** Roughly how many words a reveal would release — so the DM sees the size before clicking. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
