// Keeps the DM's table-knowledge channels (permanent facts, player recaps, lore) in the memory:
// a new post is added, an edit re-reads it, a delete removes it. Reading message text needs
// Discord's privileged Message Content intent, which must be switched on in the Developer
// Portal BEFORE this deploys — otherwise Discord refuses the bot's connection outright.

import {
  ChannelType,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Message,
  type PartialMessage,
} from "discord.js";
import {
  channelKind,
  getChannelSettingsForGuild,
  removeChannelPost,
  syncChannelPost,
  type ChannelKind,
  type SyncOutcome,
} from "@hearth/agents";

export const CHANNEL_SYNC_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

// Edits and deletes of posts the bot hasn't cached (anything from before it started, or from a
// history import) arrive as partial messages, and without these Discord doesn't send them.
export const CHANNEL_SYNC_PARTIALS = [Partials.Message, Partials.Channel];

/** The most posts a history import reads per channel. Each post is one extraction call. */
const HISTORY_LIMIT = 1000;

async function targetOf(
  message: Message | PartialMessage,
): Promise<{ campaignId: string; kind: ChannelKind } | null> {
  if (!message.guildId) return null;
  const settings = await getChannelSettingsForGuild(message.guildId);
  if (!settings) return null;
  const kind = channelKind(settings, message.channelId);
  return kind ? { campaignId: settings.campaignId, kind } : null;
}

async function sync(
  message: Message,
  campaignId: string,
  kind: ChannelKind,
): Promise<SyncOutcome | null> {
  if (message.author.bot || message.system) return null;
  return syncChannelPost({
    campaignId,
    kind,
    messageId: message.id,
    authorName:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    content: message.content,
    postedAt: message.createdAt,
  });
}

/** Listen for posts, edits, and deletes. `isAllowed` is the bot's server allowlist, so an
 * unapproved server's posts never reach the memory or cost anything. */
export function registerChannelSync(
  client: Client,
  isAllowed: (guildId: string | null) => boolean,
): void {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!isAllowed(message.guildId)) return;
      const target = await targetOf(message);
      if (target) await sync(message, target.campaignId, target.kind);
    } catch (err) {
      console.error("channel sync failed on a new post:", err);
    }
  });

  client.on(Events.MessageUpdate, async (_before, after) => {
    try {
      if (!isAllowed(after.guildId)) return;
      const target = await targetOf(after);
      if (!target) return;
      const message = after.partial ? await after.fetch() : after;
      await sync(message, target.campaignId, target.kind);
    } catch (err) {
      console.error("channel sync failed on an edited post:", err);
    }
  });

  client.on(Events.MessageDelete, async (message) => {
    try {
      if (!isAllowed(message.guildId)) return;
      const target = await targetOf(message);
      if (target) await removeChannelPost(target.campaignId, message.id);
    } catch (err) {
      console.error("channel sync failed on a deleted post:", err);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages) => {
    try {
      const first = messages.first();
      if (!first || !isAllowed(first.guildId)) return;
      const target = await targetOf(first);
      if (!target) return;
      for (const id of messages.keys()) {
        await removeChannelPost(target.campaignId, id);
      }
    } catch (err) {
      console.error("channel sync failed on a bulk delete:", err);
    }
  });
}

/** Why a channel can't be a table-knowledge channel, or null if it can. Everything posted in one
 * becomes something every player knows, so a channel @everyone can't read would leak its posts
 * to players who were never meant to see them. */
export async function knowledgeChannelProblem(
  guild: Guild,
  channelId: string,
): Promise<string | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return `<#${channelId}> isn't a text channel I can see.`;
  }
  if (
    !channel
      .permissionsFor(guild.roles.everyone)
      ?.has(PermissionFlagsBits.ViewChannel)
  ) {
    return `<#${channelId}> is private — everything in these channels becomes something every player knows, so pick one the whole server can read.`;
  }
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (
    !perms?.has(PermissionFlagsBits.ViewChannel) ||
    !perms.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return `I can't read <#${channelId}> — give me **View Channel** and **Read Message History** there.`;
  }
  return null;
}

/** Read a channel's existing posts into the memory, newest first, up to HISTORY_LIMIT. Returns
 * how many posts were added or refreshed. */
export async function importChannelHistory(
  guild: Guild,
  channelId: string,
  campaignId: string,
  kind: ChannelKind,
): Promise<number> {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return 0;

  let imported = 0;
  let read = 0;
  let before: string | undefined;
  while (read < HISTORY_LIMIT) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (page.size === 0) break;
    for (const message of page.values()) {
      read++;
      const outcome = await sync(message, campaignId, kind);
      if (outcome === "added" || outcome === "updated") imported++;
    }
    before = page.last()?.id;
    if (page.size < 100) break;
  }
  return imported;
}
