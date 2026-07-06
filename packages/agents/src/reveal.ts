// Reveal — the DM opening a piece of the memory to a character or party. Writes the
// KnowledgeGrant the permission filter reads, plus an append-only RevealEvent (the audit
// trail behind "reveal in pieces"). Targets are polymorphic: a knowledge unit, a document
// chunk, or a whole document (a document grant opens ALL its chunks — the "party finds a
// dossier" case). Idempotent — re-revealing the same thing is a no-op.

import { prisma } from "@hearth/db";

export interface RevealTarget {
  unitId?: string;
  chunkId?: string;
  documentId?: string;
}
export interface RevealScope {
  characterId?: string;
  partyId?: string;
}

/** Reveal a unit / chunk / document to a character or party. Returns whether a new grant
 * was created (false if it was already revealed). */
export async function revealTo(
  target: RevealTarget,
  scope: RevealScope,
  byMembershipId: string,
): Promise<{ revealed: boolean }> {
  const targets = [target.unitId, target.chunkId, target.documentId].filter(
    Boolean,
  );
  if (targets.length !== 1) {
    throw new Error(
      "revealTo: exactly one target (unit/chunk/document) required",
    );
  }
  if ([scope.characterId, scope.partyId].filter(Boolean).length !== 1) {
    throw new Error(
      "revealTo: exactly one scope (character or party) required",
    );
  }

  const grant = {
    knowledgeUnitId: target.unitId ?? null,
    documentChunkId: target.chunkId ?? null,
    sourceDocumentId: target.documentId ?? null,
    characterId: scope.characterId ?? null,
    partyId: scope.partyId ?? null,
    revealedByMembershipId: byMembershipId,
  };

  try {
    await prisma.knowledgeGrant.create({ data: grant });
  } catch (err) {
    // Unique violation = already revealed to this target/scope → no-op.
    if ((err as { code?: string }).code === "P2002") return { revealed: false };
    throw err;
  }

  await prisma.revealEvent.create({
    data: {
      knowledgeUnitId: target.unitId ?? null,
      documentChunkId: target.chunkId ?? null,
      sourceDocumentId: target.documentId ?? null,
      action: "REVEAL",
      scope: scope.characterId ? "CHARACTER" : "PARTY",
      characterId: scope.characterId ?? null,
      partyId: scope.partyId ?? null,
      byMembershipId,
    },
  });
  return { revealed: true };
}
