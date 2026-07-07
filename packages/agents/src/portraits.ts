// Portrait matching — pair a generated NPC with its nearest-vibe token from the asset pool.
// Same pgvector + Voyage machinery as text retrieval, just the multimodal model: portraits
// were embedded as image+label (documents); an NPC description is embedded as a query, and
// nearest-neighbor in the shared space gives the best face.

import { prisma } from "@hearth/db";
import { embedMultimodal, toVectorLiteral } from "./embeddings.js";

export interface PortraitMatch {
  storagePath: string;
  label: string;
}

/** The portrait whose embedding is nearest `description`. Searches the shared pool
 * (campaignId null) plus the campaign's own uploads. Returns null if nothing is embedded yet. */
export async function matchPortrait(
  description: string,
  campaignId?: string,
): Promise<PortraitMatch | null> {
  const [vec] = await embedMultimodal([{ text: description }], "query");
  if (!vec) return null;
  const lit = toVectorLiteral(vec);
  const rows = await prisma.$queryRaw<PortraitMatch[]>`
    SELECT "storagePath", "label"
    FROM "Asset"
    WHERE "kind" = 'portrait' AND "embedding" IS NOT NULL
      AND ("campaignId" IS NULL OR "campaignId" = ${campaignId ?? null})
    ORDER BY "embedding" <=> ${lit}::vector
    LIMIT 1`;
  return rows[0] ?? null;
}
