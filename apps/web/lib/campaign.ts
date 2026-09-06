// One place where a request becomes an authorized viewer. Every campaign page goes through
// this, so "are you allowed to be here" is answered once rather than per-page.

import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@hearth/db";
import { resolveMember, type ResolvedMember } from "@hearth/agents";

export interface CampaignContext {
  viewer: ResolvedMember;
  campaign: { id: string; name: string };
}

/** The signed-in member's context for a campaign, or a redirect/404. Non-members get a 404
 * rather than a 403 — a stranger shouldn't learn that a campaign exists. */
export async function requireMember(
  campaignId: string,
): Promise<CampaignContext> {
  const session = await auth();
  if (!session?.discordUserId) redirect("/");

  const viewer = await resolveMember(campaignId, session.discordUserId);
  if (!viewer) notFound();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true },
  });
  if (!campaign) notFound();

  return { viewer, campaign };
}

/** How a member is addressed on screen: their character, else their table name, else a role. */
export function viewerLabel(viewer: ResolvedMember): string {
  if (viewer.characterName) return viewer.characterName;
  return viewer.role === "DM" ? "Dungeon Master" : "Player";
}
