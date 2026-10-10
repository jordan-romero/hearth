// One place where a request becomes an authorized viewer. Every campaign page goes through
// this, so "are you allowed to be here" is answered once rather than per-page.

import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@hearth/db";
import {
  getWorkspaceTree,
  resolveMember,
  type ResolvedMember,
} from "@hearth/agents";

export interface CampaignContext {
  viewer: ResolvedMember;
  campaign: { id: string; name: string };
}

/** The signed-in member's context for a campaign, or a redirect/404. Non-members get a 404
 * rather than a 403 — a stranger shouldn't learn that a campaign exists. Once per request: the
 * layouts and the page all ask, and React's cache answers them from the first. */
export const requireMember = cache(
  async (campaignId: string): Promise<CampaignContext> => {
    const session = await auth();
    if (!session?.discordUserId) redirect("/");

    // Both at once: the campaign's name is only shown once the membership checks out.
    const [viewer, campaign] = await Promise.all([
      resolveMember(campaignId, session.discordUserId),
      prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, name: true },
      }),
    ]);
    if (!viewer || !campaign) notFound();

    return { viewer, campaign };
  },
);

/** The workspace's folders and pages, once per request (the layout and the open page both use
 * it). */
export const workspaceTree = cache(getWorkspaceTree);

/**
 * The same, but only for the DM.
 *
 * Hiding a nav tab is presentation, not protection — every DM-only page calls this itself, so
 * a player who types the URL is refused by the same check either way. A player gets a 404
 * rather than a 403, consistent with the rest: don't confirm that something exists.
 */
export async function requireDm(campaignId: string): Promise<CampaignContext> {
  const ctx = await requireMember(campaignId);
  if (ctx.viewer.role !== "DM") notFound();
  return ctx;
}

/** How a member is addressed on screen. The label has to match WHAT THEY'RE SEEING, not just
 * who they are: a DM who also has a character still sees everything, so showing the character
 * name would imply a filtered view they aren't in. Role wins for DMs. */
export function viewerLabel(viewer: ResolvedMember): string {
  if (viewer.role === "DM") return "Dungeon Master";
  return viewer.characterName ?? "Player";
}
