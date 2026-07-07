// A player records a private journal entry — their own knowledge, visible only to their
// character (via the grant) and the DM (via DM_ONLY). It's a first-class KnowledgeUnit, so
// it's askable by the author and shareable later, all through the same permission spine.
// Shared here (not in the bot) so the web "Add note" button reuses the identical logic.

import { prisma } from "@hearth/db";
import { embedTexts, toVectorLiteral } from "./embeddings.js";

export interface JournalNote {
  id: string;
  title: string;
  content: string;
}

/** A short title derived from the entry's first line (KnowledgeUnit.title is required). */
function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "Journal entry";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

/** Create a player's journal entry: a PLAYER_NOTE unit + a self-grant to their character, in
 * one transaction, then embed it for retrieval. Returns the created note. */
export async function addJournalNote(
  campaignId: string,
  authorMembershipId: string,
  characterId: string,
  text: string,
): Promise<JournalNote> {
  const title = deriveTitle(text);

  const unit = await prisma.$transaction(async (tx) => {
    const u = await tx.knowledgeUnit.create({
      data: {
        campaignId,
        type: "FACT",
        source: "PLAYER_NOTE",
        origin: "AUTHORED",
        baseVisibility: "DM_ONLY",
        title,
        content: text,
        authorMembershipId,
      },
    });
    // The author grants it to their own character — same mechanism as any reveal, so the
    // unit is visible to exactly them (plus the DM, who sees all DM_ONLY content).
    await tx.knowledgeGrant.create({
      data: {
        knowledgeUnitId: u.id,
        characterId,
        revealedByMembershipId: authorMembershipId,
      },
    });
    return u;
  });

  // Embed for semantic retrieval (best-effort, like other units).
  const [vec] = await embedTexts([`${title}. ${text}`], "document");
  if (vec) {
    await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${unit.id}`;
  }

  return { id: unit.id, title: unit.title, content: unit.content };
}
