// Who learned a session fact.
//
// Until now every fact from a session was stored as visible to the whole campaign. That is wrong
// in two directions: a character who wasn't at the table knows what happened, and a secret told to
// one character — a vision, a whisper, a conversation the others weren't in — is readable by
// everyone, even though only that player's character heard it in the story.
//
// So a session fact goes to the characters who learned it IN THE FICTION. Told openly at the table
// → every character who was there. Told to one character → that character alone, even though the
// other players heard it out loud. It spreads from there only if she chooses to (/share).
//
// The model proposes the audience; this decides it. Only characters actually recorded as taking
// part can be granted anything, and when the proposal can't be matched the fact reaches nobody but
// the DM — who can still reveal it deliberately. Granting too narrowly is a question the DM can
// answer later; granting too widely can't be undone, because you can't unlearn a secret.

/** What the model said about who learned a fact. */
export type ProposedAudience = "party" | string[] | undefined;

/** A character recorded as taking part in the session. */
export interface PresentCharacter {
  id: string;
  name: string;
}

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const firstWord = (name: string) => normalize(name).split(" ")[0] ?? "";

/** The characters a proposed audience really means: ids, always a subset of who was there.
 *
 * An empty result means the DM alone, which is what happens whenever the proposal names nobody who
 * was at the table — an NPC, a player who wasn't in the session, or nothing at all. */
export function decideAudience(
  proposed: ProposedAudience,
  present: PresentCharacter[],
): string[] {
  if (proposed === "party") return present.map((c) => c.id);
  if (!Array.isArray(proposed)) return [];

  // A short name counts only when it belongs to one of the characters present and to no other:
  // "Mor" for Morwyn is fine at a table without Moraine, and dropped at one with her.
  const byFirstWord = new Map<string, string | null>();
  for (const c of present) {
    const key = firstWord(c.name);
    if (!key) continue;
    byFirstWord.set(key, byFirstWord.has(key) ? null : c.id);
  }
  const byName = new Map(present.map((c) => [normalize(c.name), c.id]));

  const ids = new Set<string>();
  for (const raw of proposed) {
    if (typeof raw !== "string") continue;
    const name = normalize(raw);
    if (!name) continue;
    const exact = byName.get(name);
    if (exact) {
      ids.add(exact);
      continue;
    }
    const short = byFirstWord.get(firstWord(name));
    if (short) ids.add(short);
  }
  return [...ids];
}

/** The audience of one fact assembled from several parts of the same session.
 *
 * Extraction reads a long session in parts and merges facts about the same subject, so one stored
 * fact can carry what two parts said. If the party learned one half and a single character learned
 * the other, the merged text holds the private half — so the audience is what the parts AGREE on,
 * not everything they name. */
export function narrowestAudience(audiences: string[][]): string[] {
  if (audiences.length === 0) return [];
  return audiences.reduce((kept, next) => {
    const allowed = new Set(next);
    return kept.filter((id) => allowed.has(id));
  });
}
