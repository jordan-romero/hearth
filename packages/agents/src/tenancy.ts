// Multi-tenancy — which campaign does this request belong to?
//
// The bot serves many Discord servers from one deployment, so the campaign is resolved from
// the interaction's guild rather than an environment variable. Shared here (not in the bot)
// so a future web adapter resolves tenancy the same way.

import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";

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

/** A permission `Viewer` plus the presentation bits every adapter needs. The core `Viewer`
 * stays pure — the name and theme ride alongside for UI only. */
export interface ResolvedMember extends Viewer {
  characterName: string | null;
  membershipId: string;
  theme: string;
}

/** Resolve a Discord account to their seat in a campaign. Shared by the bot and the web app so
 * the two surfaces can never disagree about who someone is or what they may see. Returns null
 * if they aren't a member of that campaign. */
export async function resolveMember(
  campaignId: string,
  discordUserId: string,
): Promise<ResolvedMember | null> {
  const user = await prisma.user.findUnique({
    where: { discordUserId },
    include: {
      memberships: {
        where: { campaignId },
        include: {
          characters: { where: { campaignId }, take: 1 },
          campaign: { select: { theme: true } },
        },
      },
    },
  });
  const membership = user?.memberships[0];
  if (!membership) return null;
  const character = membership.characters[0];
  return {
    campaignId,
    role: membership.role,
    characterId: character?.id ?? null,
    partyId: character?.partyId ?? null,
    characterName: character?.name ?? null,
    membershipId: membership.id,
    theme: membership.campaign.theme,
  };
}

/** discordUserId → the name to put in front of their transcript lines.
 *
 * Players are their character; the DM usually has no character at all (they never `/join`), and
 * without this every line they speak reads as "Unknown" — which is most of a session, since the
 * DM narrates and voices the NPCs. A transcript that anonymises the narrator produces poor
 * recaps and extraction, so the DM is labelled as the DM. */
export async function getSpeakerLabels(
  campaignId: string,
): Promise<Map<string, string>> {
  const memberships = await prisma.membership.findMany({
    where: { campaignId },
    include: {
      user: { select: { discordUserId: true, name: true } },
      characters: { where: { campaignId }, take: 1, select: { name: true } },
    },
  });
  const labels = new Map<string, string>();
  for (const m of memberships) {
    const discordUserId = m.user.discordUserId;
    if (!discordUserId) continue;
    // A player is their character. The DM has none, so use the name they gave at /setup,
    // falling back to a plain role label.
    const character = m.characters[0]?.name;
    const fallback = m.role === "DM" ? (m.user.name ?? "DM") : "Unknown";
    labels.set(discordUserId, character ?? fallback);
  }
  return labels;
}

/** Every campaign this Discord account belongs to — the web app's campaign picker. */
export async function listCampaignsForDiscordUser(discordUserId: string) {
  const user = await prisma.user.findUnique({
    where: { discordUserId },
    include: {
      memberships: {
        include: {
          campaign: { select: { id: true, name: true, theme: true } },
        },
      },
    },
  });
  return (user?.memberships ?? []).map((m) => ({
    campaignId: m.campaign.id,
    name: m.campaign.name,
    theme: m.campaign.theme,
    role: m.role,
  }));
}
