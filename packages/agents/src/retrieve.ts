// Filter-wrapped retrieval — the backbone of "talk to the memory".
// Shape (from docs/architecture.md): search (I/O) → map → filter (core).
// The permission filter is the ONLY gate; there is deliberately no visibility logic in
// the SQL, so the rule lives in exactly one place (@hearth/core). It's the same filter
// for KnowledgeUnits AND DocumentChunks — a chunk maps onto FilterableKnowledgeUnit,
// so the spine is polymorphic for free (chunk-level grants arrive with the reveal bite).
//
// Search is hybrid: literal text first, then nearest-by-meaning. Meaning alone cannot tell
// "session 1" from "session 81" — to an embedding those are nearly the same phrase — so a
// question naming something exactly has to be able to win on the exact words.

import { prisma } from "@hearth/db";
import {
  filterKnowledge,
  type Viewer,
  type FilterableKnowledgeUnit,
} from "@hearth/core";
import { embedTexts, toVectorLiteral } from "./embeddings.js";

export interface RetrievedUnit extends FilterableKnowledgeUnit {
  title: string;
  content: string;
  type: string;
  /** Set for a player's journal note: whose note it is. Journal entries are written in the
   * first person, so once one is shared with the party it reads as if the ASKER wrote it
   * unless the answer knows who actually did. */
  authorName?: string | null;
}

/** A retrieved passage from an ingested DM document (the RAG layer). */
export interface RetrievedChunk extends FilterableKnowledgeUnit {
  text: string;
  docName: string;
  sourceDocumentId: string;
}

export interface RetrievedContext {
  units: RetrievedUnit[];
  chunks: RetrievedChunk[];
}

interface UnitRow {
  id: string;
  campaignId: string;
  baseVisibility: FilterableKnowledgeUnit["baseVisibility"];
  title: string;
  content: string;
  type: string;
  authorName: string | null;
}

interface ChunkRow {
  id: string;
  campaignId: string;
  baseVisibility: FilterableKnowledgeUnit["baseVisibility"];
  text: string;
  docName: string;
  sourceDocumentId: string;
}

/**
 * Phrases in a question that have to match literally: a word followed by a number, like
 * "session 1" or "chapter 3".
 *
 * This is the case embeddings get wrong. "Session 1" and "session 81" are almost the same
 * direction in meaning-space, so nearest-by-meaning happily returns the wrong one, and for a
 * reveal that means offering the DM the wrong session's recap.
 */
export function literalPhrases(question: string): string[] {
  const found = new Set<string>();
  const pattern = /([a-z][a-z'-]{2,})\s*#?\s*(\d{1,4})\b/gi;
  for (const match of question.matchAll(pattern)) {
    found.add(`${match[1]!.toLowerCase()} ${match[2]}`);
  }
  return [...found];
}

/**
 * A Postgres regex matching any of `phrases` as whole words, or null when there are none.
 *
 * The word boundary is the point: "session 1" must not match "session 81" or "session 111",
 * which is exactly the confusion being fixed.
 */
export function literalPhrasePattern(phrases: string[]): string | null {
  if (phrases.length === 0) return null;
  const alternatives = phrases.map((phrase) => {
    const [word, number] = phrase.split(" ");
    return `${word!.replace(/[^a-z0-9'-]/gi, "")}[[:space:]]*#?[[:space:]]*${number}`;
  });
  // \m and \M are Postgres's start/end-of-word boundaries.
  return `\\m(${alternatives.join("|")})\\M`;
}

function unitCandidates(rows: UnitRow[], grants: GrantRow[]): RetrievedUnit[] {
  return rows.map((r) => ({
    ...r,
    grantedCharacterIds: grants
      .filter((g) => g.knowledgeUnitId === r.id && g.characterId)
      .map((g) => g.characterId as string),
    grantedPartyIds: grants
      .filter((g) => g.knowledgeUnitId === r.id && g.partyId)
      .map((g) => g.partyId as string),
  }));
}

interface GrantRow {
  knowledgeUnitId: string | null;
  characterId: string | null;
  partyId: string | null;
}

/** Permission-filter unit rows, preserving their search order. */
async function allowedUnits(
  viewer: Viewer,
  rows: UnitRow[],
): Promise<RetrievedUnit[]> {
  if (rows.length === 0) return [];
  const grants = await prisma.knowledgeGrant.findMany({
    where: { knowledgeUnitId: { in: rows.map((r) => r.id) } },
    select: { knowledgeUnitId: true, characterId: true, partyId: true },
  });
  const candidates = unitCandidates(rows, grants);
  const allowed = new Set(filterKnowledge(viewer, candidates).map((u) => u.id));
  return candidates.filter((c) => allowed.has(c.id));
}

async function embedQuery(question: string): Promise<string | null> {
  const [vec] = await embedTexts([question], "query");
  return vec ? toVectorLiteral(vec) : null;
}

/** Keep the first occurrence of each id, up to `limit`. */
function mergeUnique<T extends { id: string }>(groups: T[][], limit: number) {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/** Units whose text literally matches the question's words. Full-text first, and anything
 * naming an exact "word number" phrase is ranked above it — that phrase is why this exists. */
async function searchUnitsLexical(
  viewer: Viewer,
  question: string,
  limit: number,
): Promise<RetrievedUnit[]> {
  const pattern = literalPhrasePattern(literalPhrases(question));
  const rows = await prisma.$queryRaw<UnitRow[]>`
    SELECT ku."id", ku."campaignId", ku."baseVisibility"::text AS "baseVisibility",
           ku."title", ku."content", ku."type"::text AS "type",
           ac."name" AS "authorName"
    FROM "KnowledgeUnit" ku
    LEFT JOIN "Character" ac
      ON ac."membershipId" = ku."authorMembershipId"
     AND ac."campaignId" = ku."campaignId"
    WHERE ku."campaignId" = ${viewer.campaignId}
      AND ku."supersededByCorrectionId" IS NULL
      AND (
        (${pattern}::text IS NOT NULL
          AND (ku."title" ~* ${pattern}::text OR ku."content" ~* ${pattern}::text))
        OR to_tsvector('english', ku."title" || ' ' || ku."content")
             @@ websearch_to_tsquery('english', ${question})
      )
    ORDER BY
      -- an exact "session 1" in the title beats one buried in the body, which beats a plain
      -- word match; ties fall back to full-text rank
      (CASE WHEN ${pattern}::text IS NOT NULL AND ku."title" ~* ${pattern}::text THEN 0
            WHEN ${pattern}::text IS NOT NULL AND ku."content" ~* ${pattern}::text THEN 1
            ELSE 2 END),
      ts_rank(to_tsvector('english', ku."title" || ' ' || ku."content"),
              websearch_to_tsquery('english', ${question})) DESC
    LIMIT ${limit * 3}`;
  return (await allowedUnits(viewer, rows)).slice(0, limit);
}

/** Campaign-scoped nearest KnowledgeUnits, permission-filtered. `vec` is a pgvector literal. */
async function searchUnits(
  viewer: Viewer,
  vec: string,
  limit: number,
): Promise<RetrievedUnit[]> {
  // Over-fetch (×3) so dropping gated units still leaves a good set for the viewer.
  const rows = await prisma.$queryRaw<UnitRow[]>`
    SELECT ku."id", ku."campaignId", ku."baseVisibility"::text AS "baseVisibility",
           ku."title", ku."content", ku."type"::text AS "type",
           ac."name" AS "authorName"
    FROM "KnowledgeUnit" ku
    -- Who wrote it, when it's a player's note (see RetrievedUnit.authorName).
    LEFT JOIN "Character" ac
      ON ac."membershipId" = ku."authorMembershipId"
     AND ac."campaignId" = ku."campaignId"
    WHERE ku."campaignId" = ${viewer.campaignId} AND ku."embedding" IS NOT NULL
      -- A fact the table has corrected is never retrieved again. This is the whole point of a
      -- correction: the wrong answer has to become unreachable, not merely outranked.
      AND ku."supersededByCorrectionId" IS NULL
    ORDER BY ku."embedding" <=> ${vec}::vector
    LIMIT ${limit * 3}`;
  return (await allowedUnits(viewer, rows)).slice(0, limit);
}

/** Permission-filter chunk rows, preserving their search order. */
async function allowedChunks(
  viewer: Viewer,
  rows: ChunkRow[],
): Promise<RetrievedChunk[]> {
  if (rows.length === 0) return [];
  // A chunk is granted to a viewer if the chunk itself is revealed, OR its whole parent
  // document is revealed. Load both kinds of grant for the candidate chunks/docs.
  const docIds = [...new Set(rows.map((r) => r.sourceDocumentId))];
  const grants = await prisma.knowledgeGrant.findMany({
    where: {
      OR: [
        { documentChunkId: { in: rows.map((r) => r.id) } },
        { sourceDocumentId: { in: docIds } },
      ],
    },
    select: {
      documentChunkId: true,
      sourceDocumentId: true,
      characterId: true,
      partyId: true,
    },
  });

  const candidates: RetrievedChunk[] = rows.map((r) => {
    const relevant = grants.filter(
      (g) =>
        g.documentChunkId === r.id ||
        (g.sourceDocumentId !== null &&
          g.sourceDocumentId === r.sourceDocumentId),
    );
    return {
      id: r.id,
      campaignId: r.campaignId,
      baseVisibility: r.baseVisibility,
      grantedCharacterIds: relevant
        .filter((g) => g.characterId)
        .map((g) => g.characterId as string),
      grantedPartyIds: relevant
        .filter((g) => g.partyId)
        .map((g) => g.partyId as string),
      text: r.text,
      docName: r.docName,
      sourceDocumentId: r.sourceDocumentId,
    };
  });

  const allowed = new Set(filterKnowledge(viewer, candidates).map((c) => c.id));
  return candidates.filter((c) => allowed.has(c.id));
}

/** Passages whose text literally matches the question's words. */
async function searchChunksLexical(
  viewer: Viewer,
  question: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const pattern = literalPhrasePattern(literalPhrases(question));
  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT c."id", c."campaignId", c."baseVisibility"::text AS "baseVisibility",
           c."text", c."sourceDocumentId", d."name" AS "docName"
    FROM "DocumentChunk" c
    JOIN "SourceDocument" d ON d."id" = c."sourceDocumentId"
    WHERE c."campaignId" = ${viewer.campaignId}
      AND c."supersededByCorrectionId" IS NULL
      AND (
        (${pattern}::text IS NOT NULL AND c."text" ~* ${pattern}::text)
        OR to_tsvector('english', c."text") @@ websearch_to_tsquery('english', ${question})
      )
    ORDER BY
      (CASE WHEN ${pattern}::text IS NOT NULL AND c."text" ~* ${pattern}::text THEN 0 ELSE 1 END),
      ts_rank(to_tsvector('english', c."text"),
              websearch_to_tsquery('english', ${question})) DESC
    LIMIT ${limit * 3}`;
  return (await allowedChunks(viewer, rows)).slice(0, limit);
}

/** Campaign-scoped nearest DocumentChunks, permission-filtered. */
async function searchChunks(
  viewer: Viewer,
  vec: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT c."id", c."campaignId", c."baseVisibility"::text AS "baseVisibility",
           c."text", c."sourceDocumentId", d."name" AS "docName"
    FROM "DocumentChunk" c
    JOIN "SourceDocument" d ON d."id" = c."sourceDocumentId"
    WHERE c."campaignId" = ${viewer.campaignId} AND c."embedding" IS NOT NULL
      -- Same rule as units: a passage the table has corrected is never retrieved again.
      AND c."supersededByCorrectionId" IS NULL
    ORDER BY c."embedding" <=> ${vec}::vector
    LIMIT ${limit * 3}`;
  return (await allowedChunks(viewer, rows)).slice(0, limit);
}

/** The units most relevant to `question` that `viewer` may know (kept for callers/tests). */
export async function retrieveForViewer(
  viewer: Viewer,
  question: string,
  limit = 8,
): Promise<RetrievedUnit[]> {
  const { units } = await retrieveContext(viewer, question, {
    unitLimit: limit,
    chunkLimit: 0,
  });
  return units;
}

/**
 * Retrieve BOTH knowledge units and document chunks for `question`, permission-filtered.
 *
 * Literal matches come first and nearest-by-meaning fills the rest, so naming something
 * exactly ("session 1") wins over something that merely reads like it ("session 81"), while a
 * question with no exact words to match still gets the semantic answer it always did.
 */
export async function retrieveContext(
  viewer: Viewer,
  question: string,
  opts: { unitLimit?: number; chunkLimit?: number } = {},
): Promise<RetrievedContext> {
  const unitLimit = opts.unitLimit ?? 8;
  const chunkLimit = opts.chunkLimit ?? 6;
  const vec = await embedQuery(question);

  const [lexicalUnits, lexicalChunks, semanticUnits, semanticChunks] =
    await Promise.all([
      unitLimit > 0
        ? searchUnitsLexical(viewer, question, unitLimit)
        : Promise.resolve([]),
      chunkLimit > 0
        ? searchChunksLexical(viewer, question, chunkLimit)
        : Promise.resolve([]),
      vec && unitLimit > 0
        ? searchUnits(viewer, vec, unitLimit)
        : Promise.resolve([]),
      vec && chunkLimit > 0
        ? searchChunks(viewer, vec, chunkLimit)
        : Promise.resolve([]),
    ]);

  return {
    units: mergeUnique([lexicalUnits, semanticUnits], unitLimit),
    chunks: mergeUnique([lexicalChunks, semanticChunks], chunkLimit),
  };
}
