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
import { retrieveForViewer } from "./retrieve.js";
import { revealTo } from "./reveal.js";

export interface ShareCandidate {
  id: string;
  title: string;
  content: string;
}

export interface ShareProposal {
  id: string;
  unit: ShareCandidate;
  note?: string;
  /** True when the party can already see it — nothing was filed. */
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
 * Find the thing the player means and file a request to share it with the party.
 *
 * `about` is matched semantically against what THEY can see — usually their own journal entry
 * ("the sigil I sketched"), but anything they know is fair game.
 */
export async function proposeShare(
  viewer: Viewer,
  membershipId: string,
  about: string,
  note?: string,
): Promise<ShareProposal | null> {
  const [best] = await retrieveForViewer(viewer, about, 1);
  if (!best) return null;

  if (await partyAlreadyHas(best.id, viewer.partyId)) {
    return {
      id: "",
      unit: { id: best.id, title: best.title, content: best.content },
      note,
      alreadyShared: true,
    };
  }

  const request = await prisma.shareRequest.create({
    data: {
      campaignId: viewer.campaignId,
      knowledgeUnitId: best.id,
      note,
      proposedByMembershipId: membershipId,
    },
  });

  return {
    id: request.id,
    unit: { id: best.id, title: best.title, content: best.content },
    note,
    alreadyShared: false,
  };
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
    include: {
      proposedBy: { include: { characters: { take: 1 } } },
    },
  });

  // The party the sharer belongs to — a share is "tell my party", not "tell everyone".
  const partyId =
    request.proposedBy?.characters[0]?.partyId ??
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
