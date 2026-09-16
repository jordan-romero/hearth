// Reveal — the DM opening a piece of the memory to a character or party. Writes the
// KnowledgeGrant the permission filter reads, plus an append-only RevealEvent (the audit
// trail behind "reveal in pieces"). Targets are polymorphic: a knowledge unit, a document
// chunk, or a whole document (a document grant opens ALL its chunks — the "party finds a
// dossier" case). Idempotent — re-revealing the same thing is a no-op.

import { prisma } from "@hearth/db";
import { sectionFor } from "./sections.js";

/** A passage of a section, with the document it belongs to. */
export interface SectionPassageRow {
  id: string;
  chunkIndex: number;
  text: string;
  docName: string;
}

/**
 * The passages forming the section that contains `anchorChunkId`, in order.
 *
 * Called twice for one reveal — once to preview the section and once when the DM confirms —
 * rather than carrying a list of ids through a Discord button, whose custom id is far too small
 * to hold them. The boundary rules are deterministic, so both calls see the same section.
 *
 * A passage retired by a correction is left out, which can split a section in two; the DM then
 * reveals the part their anchor sits in. That is the safe direction to be wrong in.
 */
export async function sectionPassages(
  anchorChunkId: string,
): Promise<SectionPassageRow[]> {
  const anchor = await prisma.documentChunk.findUnique({
    where: { id: anchorChunkId },
    select: { sourceDocumentId: true, chunkIndex: true },
  });
  if (!anchor) return [];
  const rows = await prisma.documentChunk.findMany({
    where: {
      sourceDocumentId: anchor.sourceDocumentId,
      supersededByCorrectionId: null,
    },
    select: {
      id: true,
      chunkIndex: true,
      text: true,
      sourceDocument: { select: { name: true } },
    },
    orderBy: { chunkIndex: "asc" },
  });
  return sectionFor(
    rows.map((r) => ({
      id: r.id,
      chunkIndex: r.chunkIndex,
      text: r.text,
      docName: r.sourceDocument.name,
    })),
    anchor.chunkIndex,
  );
}

export interface RevealTarget {
  unitId?: string;
  chunkId?: string;
  documentId?: string;
}
export interface RevealScope {
  characterId?: string;
  partyId?: string;
}

/**
 * Reveal a run of passages — a whole section — as one act.
 *
 * A single passage is a slice of a piece, so revealing one hands over part of a recap. This
 * grants every passage in the section together: either the DM released the piece or they did
 * not. Passages already revealed are skipped rather than failing the rest, so re-revealing an
 * overlapping section tops it up instead of erroring.
 *
 * Returns how many passages were newly revealed (0 when the section was already open).
 */
export async function revealPassages(
  chunkIds: string[],
  scope: RevealScope,
  byMembershipId: string,
): Promise<{ revealed: number }> {
  let revealed = 0;
  for (const chunkId of chunkIds) {
    const result = await revealTo({ chunkId }, scope, byMembershipId);
    if (result.revealed) revealed += 1;
  }
  return { revealed };
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

  // The grant and its audit event must land together: if the event write failed after the
  // grant committed, a retry would hit the unique constraint below and silently drop the
  // RevealEvent — losing an entry from the append-only log. One transaction keeps them
  // consistent (a mid-way failure rolls the grant back too, so the retry re-creates both).
  try {
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeGrant.create({ data: grant });
      await tx.revealEvent.create({
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
    });
  } catch (err) {
    // Unique violation = already revealed to this target/scope → no-op.
    if ((err as { code?: string }).code === "P2002") return { revealed: false };
    throw err;
  }
  return { revealed: true };
}
