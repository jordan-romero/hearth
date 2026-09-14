// Self-service onboarding — a DM creates a campaign in their server, players join it with a
// character. This replaces the hand-run seed/link scripts, and is what lets one deployment
// serve several tables. Shared here (not in the bot) so a web adapter onboards identically.

import { prisma } from "@hearth/db";

/** Discord-only signup has no real email yet (Auth.js arrives with the web app), so users get
 * a stable synthetic one derived from their Discord id. */
function placeholderEmail(discordUserId: string): string {
  return `discord-${discordUserId}@hearth.local`;
}

/** Find or create the Hearth user behind a Discord account. Per-table naming lives on the
 * membership, not here — this name is only a fallback. */
async function upsertUser(discordUserId: string, displayName: string) {
  const existing = await prisma.user.findUnique({ where: { discordUserId } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      discordUserId,
      email: placeholderEmail(discordUserId),
      name: displayName,
    },
  });
}

export interface SetupResult {
  campaignId: string;
  campaignName: string;
  alreadyExisted: boolean;
  /** Where reveals and shared NPCs get posted, after this call. */
  revealChannelId: string | null;
}

/** Create a campaign for a Discord server and make the runner its DM. Idempotent: if the
 * server already has a campaign, returns it untouched rather than creating a second one. */
export async function setupCampaign(
  guildId: string,
  discordUserId: string,
  displayName: string,
  campaignName: string,
  dmName?: string,
  revealChannelId?: string,
  dmPronouns?: string,
  firstSessionNumber?: number,
  channels: {
    factsChannelId?: string;
    recapsChannelId?: string;
    loreChannelId?: string;
  } = {},
): Promise<SetupResult> {
  const cleanPronouns = dmPronouns?.trim() || undefined;
  const channelChanges = {
    ...(channels.factsChannelId
      ? { factsChannelId: channels.factsChannelId }
      : {}),
    ...(channels.recapsChannelId
      ? { recapsChannelId: channels.recapsChannelId }
      : {}),
    ...(channels.loreChannelId
      ? { loreChannelId: channels.loreChannelId }
      : {}),
  };
  const link = await prisma.campaignDiscord.findUnique({
    where: { guildId },
    include: { campaign: { select: { id: true, name: true } } },
  });
  if (link) {
    // Already set up, so this is an adjustment rather than a creation — that's the only way
    // to change where reveals go, and re-running /setup is where people will look for it.
    const discordChanges = {
      ...(revealChannelId ? { revealChannelId } : {}),
      ...channelChanges,
    };
    const updated =
      Object.keys(discordChanges).length > 0
        ? await prisma.campaignDiscord.update({
            where: { guildId },
            data: discordChanges,
          })
        : link;
    if (cleanPronouns) {
      await prisma.membership.updateMany({
        where: {
          campaignId: link.campaign.id,
          role: "DM",
          user: { discordUserId },
        },
        data: { pronouns: cleanPronouns },
      });
    }
    if (firstSessionNumber) {
      await prisma.campaign.update({
        where: { id: link.campaign.id },
        data: { firstSessionNumber },
      });
    }
    return {
      campaignId: link.campaign.id,
      campaignName: link.campaign.name,
      alreadyExisted: true,
      revealChannelId: updated.revealChannelId,
    };
  }

  const user = await upsertUser(discordUserId, displayName);
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        name: campaignName,
        ...(firstSessionNumber ? { firstSessionNumber } : {}),
      },
    });
    await tx.campaignDiscord.create({
      data: {
        campaignId: created.id,
        guildId,
        revealChannelId,
        ...channelChanges,
      },
    });
    // The DM's chosen name labels their lines in every transcript. Stored per-membership, so
    // DMing a second campaign under a different name can't relabel this one's history.
    await tx.membership.create({
      data: {
        userId: user.id,
        campaignId: created.id,
        role: "DM",
        displayName: dmName?.trim() || displayName,
        pronouns: cleanPronouns ?? null,
      },
    });
    // Every campaign gets one party, so `/reveal to:party` works from day one.
    await tx.party.create({
      data: { campaignId: created.id, name: "The Party" },
    });
    return created;
  });

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    alreadyExisted: false,
    revealChannelId: revealChannelId ?? null,
  };
}

export type JoinResult =
  | {
      kind: "joined";
      characterId: string;
      characterName: string;
      renamed: boolean; // true when an existing character was renamed rather than created
    }
  // The DM's seat comes from /setup. A character would put them in the party.
  | { kind: "dm" };

/** Join the campaign bound to a server as a player with `characterName`. Idempotent: running
 * it again renames the caller's existing character instead of creating duplicates. */
export async function joinCampaign(
  campaignId: string,
  discordUserId: string,
  displayName: string,
  characterName: string,
  details: {
    pronouns?: string;
    className?: string;
    ancestry?: string;
    level?: number;
  } = {},
): Promise<JoinResult> {
  const user = await upsertUser(discordUserId, displayName);
  const membership = await prisma.membership.upsert({
    where: { userId_campaignId: { userId: user.id, campaignId } },
    create: { userId: user.id, campaignId, role: "PLAYER" },
    update: {}, // never downgrade an existing DM to PLAYER
    include: { characters: { where: { campaignId }, take: 1 } },
  });

  if (membership.role === "DM") return { kind: "dm" };

  // Anything left out keeps its current value, so re-running /join just to rename doesn't
  // wipe the sheet given the first time.
  const clean = (v?: string) => v?.trim() || undefined;
  const sheet = {
    ...(clean(details.pronouns) ? { pronouns: clean(details.pronouns) } : {}),
    ...(clean(details.className) ? { class: clean(details.className) } : {}),
    ...(clean(details.ancestry) ? { ancestry: clean(details.ancestry) } : {}),
    ...(details.level ? { level: details.level } : {}),
  };
  const party = await prisma.party.findFirst({ where: { campaignId } });
  const existing = membership.characters?.[0];
  if (existing) {
    await prisma.character.update({
      where: { id: existing.id },
      data: { name: characterName, ...sheet },
    });
    return {
      kind: "joined",
      characterId: existing.id,
      characterName,
      renamed: true,
    };
  }
  const created = await prisma.character.create({
    data: {
      campaignId,
      membershipId: membership.id,
      partyId: party?.id ?? null,
      name: characterName,
      ...sheet,
    },
  });
  return {
    kind: "joined",
    characterId: created.id,
    characterName,
    renamed: false,
  };
}
