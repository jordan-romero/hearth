// The question behind a "Reveal to…" button.
//
// A DM reads an answer and wants to release some of it. The button carries only a random id; the
// question itself is held here, because a Discord custom id is capped at 100 characters and is
// readable by anyone who can see the message. Drafts are transient — the DM clicks within
// minutes, or asks again — so they live in memory and are swept on a TTL.
//
// A draft also remembers which campaign it came from: the same Discord account can be the DM of
// two tables, and a button clicked in one must never look something up in the other.

export interface RevealDraft {
  question: string;
  campaignId: string;
  touchedAt: number;
}

/** How long a draft stays clickable. Long enough to read a briefing and think. */
export const REVEAL_DRAFT_TTL_MS = 30 * 60_000;

export class RevealDrafts {
  private readonly drafts = new Map<string, RevealDraft>();

  constructor(private readonly ttlMs: number = REVEAL_DRAFT_TTL_MS) {}

  /** Keep a question and return the id to put in the button. */
  put(id: string, question: string, campaignId: string, now: number): string {
    this.drafts.set(id, { question, campaignId, touchedAt: now });
    return id;
  }

  /** The draft, if it's still alive and belongs to this campaign. Reading it keeps it alive: a
   * DM who is still working through the same answer shouldn't lose it mid-flow. */
  get(id: string, campaignId: string, now: number): RevealDraft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    if (now - draft.touchedAt > this.ttlMs) {
      this.drafts.delete(id);
      return null;
    }
    if (draft.campaignId !== campaignId) return null;
    draft.touchedAt = now;
    return draft;
  }

  /** Drop what nobody came back for, so an abandoned draft can't sit in memory forever. */
  sweep(now: number): number {
    let dropped = 0;
    for (const [id, draft] of this.drafts) {
      if (now - draft.touchedAt > this.ttlMs) {
        this.drafts.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.drafts.size;
  }
}
