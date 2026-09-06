// Multi-tenancy — which campaign does this request belong to?
//
// The bot serves many Discord servers from one deployment, so the campaign is resolved from
// the interaction's guild rather than an environment variable. Shared here (not in the bot)
// so a future web adapter resolves tenancy the same way.

import { prisma } from "@hearth/db";

/** The campaign bound to a Discord server, or null if it hasn't been set up yet. */
export async function resolveCampaignId(
  guildId: string,
): Promise<string | null> {
  const link = await prisma.campaignDiscord.findUnique({
    where: { guildId },
    select: { campaignId: true },
  });
  return link?.campaignId ?? null;
}

/** The campaign's Discord settings (reveals channel, …), by campaign. */
export async function getCampaignDiscord(campaignId: string) {
  return prisma.campaignDiscord.findUnique({ where: { campaignId } });
}
