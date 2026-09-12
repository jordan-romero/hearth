// A player telling the party something they know.
//
// The mirror of a correction, and the same shape: the player proposes, the DM approves, and
// only then does it reach shared memory. That mirrors how a table actually works — a player
// can volunteer their character's backstory or what they found, but the DM stays the authority
// on what becomes canon.
//
// The permission spine bounds this for free. Candidates come from filtered retrieval, so a
// player can only ever offer something they can already see: they cannot fish for a DM secret
// by trying to "share" it, because it was never a candidate in the first place.
//
// On approval this is just a reveal — the same revealTo() the DM's own /reveal uses, so shared
// knowledge arrives through one code path with one audit trail rather than a parallel one.

import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { filterKnowledge } from "@hearth/core";
import { retrieveForViewer } from "./retrieve.js";
import { revealTo } from "./reveal.js";

export interface ShareCandidate {
  id: string;
  title: string;
  content: string;
}

export interface ShareMatch {
  unit: ShareCandidate;
  /** True when the party can already see it — there's nothing to share. */
  alreadyShared: boolean;
}

/** What the party can already see, so a share doesn't propose a no-op. */
async function partyAlreadyHas(
  unitId: string,
  partyId: string | null,
): Promise<boolean> {
  const unit = await prisma.knowledgeUnit.findUnique({
    where: { id: unitId },
    select: { baseVisibility: true },
  });
  if (unit?.baseVisibility === "EVERYONE") return true;
  if (!partyId) return false;
  const grant = await prisma.knowledgeGrant.findFirst({
    where: { knowledgeUnitId: unitId, partyId },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Find what the player means, WITHOUT filing anything.
 *
 * Semantic matching can pick the wrong thing, so the player confirms before a request exists —
 * the same shape as /reveal, which previews before it grants. `about` is matched against what
 * THEY can see, so a player can't fish for a DM secret by trying to share it.
 */
export async function findShareCandidate(
  viewer: Viewer,
  about: string,
): Promise<ShareMatch | null> {
  const [best] = await retrieveForViewer(viewer, about, 1);
  if (!best) return null;
  return {
    unit: { id: best.id, title: best.title, content: best.content },
    alreadyShared: await partyAlreadyHas(best.id, viewer.partyId),
  };
}

/**
 * File the request, once the player has confirmed what they meant.
 *
 * Re-resolves the unit through the viewer's own retrieval rather than trusting the id that
 * came back through a Discord interaction — an id from a button is user input.
 */
export async function requestShare(
  viewer: Viewer,
  membershipId: string,
  unitId: string,
  note?: string,
): Promise<{ id: string; alreadyPending: boolean }> {
  const unit = await prisma.knowledgeUnit.findFirst({
    where: {
      id: unitId,
      campaignId: viewer.campaignId,
      // A correction may have retired it since the player looked it up; sharing a fact the
      // table has disowned would put it back in front of everyone.
      supersededByCorrectionId: null,
    },
    select: {
      id: true,
      campaignId: true,
      baseVisibility: true,
      grants: { select: { characterId: true, partyId: true } },
    },
  });
  if (!unit) throw new Error("that isn't something you can share");

  // Ask the filter directly rather than re-running semantic search. Search is ranked and could
  // fail to return a unit even for its own text, which would reject a share the player is
  // perfectly entitled to make; the filter is the actual authority and is deterministic.
  const canSee = filterKnowledge(viewer, [
    {
      id: unit.id,
      campaignId: unit.campaignId,
      baseVisibility: unit.baseVisibility,
      grantedCharacterIds: unit.grants
        .map((g) => g.characterId)
        .filter((v): v is string => v !== null),
      grantedPartyIds: unit.grants
        .map((g) => g.partyId)
        .filter((v): v is string => v !== null),
    },
  ]);
  if (canSee.length === 0) {
    throw new Error("that isn't something you can share");
  }

  // One pending request per unit: re-running /share shouldn't queue the DM the same decision
  // several times.
  const existing = await prisma.shareRequest.findFirst({
    where: {
      campaignId: viewer.campaignId,
      knowledgeUnitId: unitId,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, alreadyPending: true };

  const request = await prisma.shareRequest.create({
    data: {
      campaignId: viewer.campaignId,
      knowledgeUnitId: unitId,
      note,
      partyId: viewer.partyId,
      proposedByMembershipId: membershipId,
    },
  });
  return { id: request.id, alreadyPending: false };
}

/**
 * Approve a share: grant the unit to the party through the normal reveal path.
 *
 * Claimed atomically, like a correction — two clicks on the same message must not both run,
 * and an already-rejected request must not slip through.
 */
export async function approveShare(
  shareId: string,
  reviewerMembershipId: string,
  campaignId: string,
): Promise<{ unitId: string; partyId: string | null }> {
  const claimed = await prisma.shareRequest.updateMany({
    where: { id: shareId, campaignId, status: "PENDING" },
    data: {
      status: "APPROVED",
      reviewedByMembershipId: reviewerMembershipId,
      reviewedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    throw new Error("that share is not awaiting a decision");
  }

  const request = await prisma.shareRequest.findFirstOrThrow({
    where: { id: shareId, campaignId },
  });

  // The audience recorded when the share was requested. A DM sharing has no party of their
  // own, so fall back to the campaign's party — that IS "the party" for them.
  const partyId =
    request.partyId ??
    (await prisma.party.findFirst({ where: { campaignId } }))?.id ??
    null;

  if (partyId) {
    await revealTo(
      { unitId: request.knowledgeUnitId },
      { partyId },
      reviewerMembershipId,
    );
  }
  return { unitId: request.knowledgeUnitId, partyId };
}

/** The DM would rather this stayed private. Nothing changes but the record of the decision. */
export async function rejectShare(
  shareId: string,
  reviewerMembershipId: string,
  campaignId: string,
  reviewNote?: string,
): Promise<void> {
  const { count } = await prisma.shareRequest.updateMany({
    where: { id: shareId, campaignId, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedByMembershipId: reviewerMembershipId,
      reviewedAt: new Date(),
      reviewNote,
    },
  });
  if (count === 0) throw new Error("that share is not awaiting a decision");
}

/** A pending share with the unit it would reveal, for the DM's review. */
export async function getShareForReview(shareId: string, campaignId: string) {
  return prisma.shareRequest.findFirst({
    where: { id: shareId, campaignId },
    include: {
      knowledgeUnit: { select: { title: true, content: true } },
      proposedBy: {
        include: { characters: { where: { campaignId }, take: 1 } },
      },
    },
  });
}
