// Filter-wrapped semantic retrieval — the backbone of "talk to the memory".
// Shape (from docs/architecture.md): similarity search (I/O) → map → filter (core).
// The permission filter is the ONLY gate; there is deliberately no visibility
// logic in the SQL, so the rule lives in exactly one place (@hearth/core).

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

interface Row {
  id: string;
  campaignId: string;
  baseVisibility: FilterableKnowledgeUnit["baseVisibility"];
  title: string;
  content: string;
  type: string;
}

/**
 * Return the units most relevant to `question` that `viewer` is allowed to know.
 * Over-fetches by similarity, then drops everything the filter forbids.
 */
export async function retrieveForViewer(
  viewer: Viewer,
  question: string,
  limit = 8,
): Promise<RetrievedUnit[]> {
  const [queryVec] = await embedTexts([question], "query");
  if (!queryVec) return [];
  const vec = toVectorLiteral(queryVec);

  // Campaign-scoped nearest neighbours by cosine distance. Over-fetch (×3) so
  // that dropping gated units still leaves a good set for the viewer.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "id", "campaignId", "baseVisibility"::text AS "baseVisibility",
           "title", "content", "type"::text AS "type"
    FROM "KnowledgeUnit"
    WHERE "campaignId" = ${viewer.campaignId} AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${limit * 3}`;

  if (rows.length === 0) return [];

  // Load grants for the candidates → build the filter's input shape.
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

  // ── THE SPINE ── drop everything the viewer may not know, then take the top N.
  const allowed = new Set(filterKnowledge(viewer, candidates).map((u) => u.id));
  return candidates.filter((c) => allowed.has(c.id)).slice(0, limit);
}
