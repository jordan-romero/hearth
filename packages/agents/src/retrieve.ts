// Filter-wrapped semantic retrieval — the backbone of "talk to the memory".
// Shape (from docs/architecture.md): similarity search (I/O) → map → filter (core).
// The permission filter is the ONLY gate; there is deliberately no visibility logic in
// the SQL, so the rule lives in exactly one place (@hearth/core). It's the same filter
// for KnowledgeUnits AND DocumentChunks — a chunk maps onto FilterableKnowledgeUnit,
// so the spine is polymorphic for free (chunk-level grants arrive with the reveal bite).

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
}

interface ChunkRow {
  id: string;
  campaignId: string;
  baseVisibility: FilterableKnowledgeUnit["baseVisibility"];
  text: string;
  docName: string;
  sourceDocumentId: string;
}

async function embedQuery(question: string): Promise<string | null> {
  const [vec] = await embedTexts([question], "query");
  return vec ? toVectorLiteral(vec) : null;
}

/** Campaign-scoped nearest KnowledgeUnits, permission-filtered. `vec` is a pgvector literal. */
async function searchUnits(
  viewer: Viewer,
  vec: string,
  limit: number,
): Promise<RetrievedUnit[]> {
  // Over-fetch (×3) so dropping gated units still leaves a good set for the viewer.
  const rows = await prisma.$queryRaw<UnitRow[]>`
    SELECT "id", "campaignId", "baseVisibility"::text AS "baseVisibility",
           "title", "content", "type"::text AS "type"
    FROM "KnowledgeUnit"
    WHERE "campaignId" = ${viewer.campaignId} AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${limit * 3}`;
  if (rows.length === 0) return [];

  const grants = await prisma.knowledgeGrant.findMany({
    where: { knowledgeUnitId: { in: rows.map((r) => r.id) } },
    select: { knowledgeUnitId: true, characterId: true, partyId: true },
  });
  const candidates: RetrievedUnit[] = rows.map((r) => ({
    ...r,
    grantedCharacterIds: grants
      .filter((g) => g.knowledgeUnitId === r.id && g.characterId)
      .map((g) => g.characterId as string),
    grantedPartyIds: grants
      .filter((g) => g.knowledgeUnitId === r.id && g.partyId)
      .map((g) => g.partyId as string),
  }));

  const allowed = new Set(filterKnowledge(viewer, candidates).map((u) => u.id));
  return candidates.filter((c) => allowed.has(c.id)).slice(0, limit);
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
    ORDER BY c."embedding" <=> ${vec}::vector
    LIMIT ${limit * 3}`;
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
  return candidates.filter((c) => allowed.has(c.id)).slice(0, limit);
}

/** The units most relevant to `question` that `viewer` may know (kept for callers/tests). */
export async function retrieveForViewer(
  viewer: Viewer,
  question: string,
  limit = 8,
): Promise<RetrievedUnit[]> {
  const vec = await embedQuery(question);
  return vec ? searchUnits(viewer, vec, limit) : [];
}

/** Retrieve BOTH knowledge units and document chunks for `question`, permission-filtered.
 * Embeds the question once, then searches both sources. */
export async function retrieveContext(
  viewer: Viewer,
  question: string,
  opts: { unitLimit?: number; chunkLimit?: number } = {},
): Promise<RetrievedContext> {
  const vec = await embedQuery(question);
  if (!vec) return { units: [], chunks: [] };
  const [units, chunks] = await Promise.all([
    searchUnits(viewer, vec, opts.unitLimit ?? 8),
    searchChunks(viewer, vec, opts.chunkLimit ?? 6),
  ]);
  return { units, chunks };
}
