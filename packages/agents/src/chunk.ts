// Split long text into overlapping chunks for embedding. Character-based with a small
// overlap so a passage that straddles a boundary is still retrievable, and it prefers to
// break on a paragraph/sentence edge near the target size rather than mid-word.

const TARGET = 1500; // chars per chunk
const OVERLAP = 200; // chars carried into the next chunk

export function chunkText(text: string): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + TARGET, clean.length);
    if (end < clean.length) {
      // Back off to the nearest paragraph/sentence break in the second half of the
      // window (keeps chunks a reasonable size while avoiding mid-sentence cuts).
      const window = clean.slice(start, end);
      const brk = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
      );
      if (brk > TARGET * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - OVERLAP; // end - start is always > TARGET*0.5 > OVERLAP → progress
  }
  return chunks;
}
