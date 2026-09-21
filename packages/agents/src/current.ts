// What still counts as the campaign's memory.
//
// Two things retire material without deleting it, and every read has to respect both:
//
//  1. A correction — the table said a fact or passage was wrong (`supersededByCorrectionId`).
//  2. A replaced document — the DM uploaded a newer version of the same file
//     (`SourceDocument.supersededById`). Its passages and facts stop being used in answers,
//     reveal offers, search and the graph.
//
// Neither deletes anything, and that's deliberate: deleting a passage or fact cascades its
// KnowledgeGrants, which would silently revoke reveals players already have. So a reveal granted
// from an old version still resolves — the table was shown it, and nothing can take that back —
// while new answers are written from the current version only.
//
// These merge with a caller's own conditions under AND, so they can never collide with an OR or
// NOT the caller is already using.

import { Prisma } from "@hearth/db";

/** A passage that still counts: not corrected, and not from a replaced document. */
const PASSAGE_IS_CURRENT: Prisma.DocumentChunkWhereInput = {
  supersededByCorrectionId: null,
  sourceDocument: { supersededById: null },
};

/** A fact that still counts. Session facts, player notes and generated NPCs have no source
 * document, so the document condition must not exclude them. */
const FACT_IS_CURRENT: Prisma.KnowledgeUnitWhereInput = {
  supersededByCorrectionId: null,
  OR: [
    { sourceDocumentId: null },
    { sourceDocument: { supersededById: null } },
  ],
};

export function currentPassages(
  where: Prisma.DocumentChunkWhereInput = {},
): Prisma.DocumentChunkWhereInput {
  return { AND: [where, PASSAGE_IS_CURRENT] };
}

export function currentFacts(
  where: Prisma.KnowledgeUnitWhereInput = {},
): Prisma.KnowledgeUnitWhereInput {
  return { AND: [where, FACT_IS_CURRENT] };
}

/** The same two rules in SQL, spliced into the raw vector and full-text searches.
 *
 * The passage form needs a joined "SourceDocument" as `d`. A fact's document is optional, so its
 * condition is written as "no replaced document stands behind this row", which keeps session
 * facts and player notes (they have no document at all). */
export const sqlPassageIsCurrent = Prisma.sql`c."supersededByCorrectionId" IS NULL
      AND d."supersededById" IS NULL`;

export const sqlFactIsCurrent = Prisma.sql`ku."supersededByCorrectionId" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "SourceDocument" sd
        WHERE sd."id" = ku."sourceDocumentId" AND sd."supersededById" IS NOT NULL
      )`;
