// Channels a DM designates as table knowledge: permanent facts, player recaps, lore. Every post
// becomes its own document, visible to everyone, keyed by its Discord message id so an edit
// re-reads it and a delete takes it (passages, facts, stored text) out of the memory. It goes
// through the same ingestion as an upload, so secrets in a post are still held apart.

import { prisma } from "@hearth/db";
import {
  removeExternalDocument,
  syncExternalDocument,
  type SyncOutcome,
} from "./external.js";

export type { SyncOutcome };

export type ChannelKind = "facts" | "recaps" | "lore";

export interface ChannelSettings {
  factsChannelId: string | null;
  recapsChannelId: string | null;
  loreChannelId: string | null;
}

/** Which kind of table-knowledge channel this is, or null for any other channel. */
export function channelKind(
  settings: ChannelSettings,
  channelId: string,
): ChannelKind | null {
  if (settings.factsChannelId === channelId) return "facts";
  if (settings.recapsChannelId === channelId) return "recaps";
  if (settings.loreChannelId === channelId) return "lore";
  return null;
}

const KIND_LABEL: Record<ChannelKind, string> = {
  facts: "Fact",
  recaps: "Recap",
  lore: "Lore",
};

/** How a post is named in the library: its kind, who wrote it, and the day it was posted. */
export function channelDocumentName(
  kind: ChannelKind,
  authorName: string,
  postedAt: Date,
): string {
  return `${KIND_LABEL[kind]} — ${authorName}, ${postedAt.toISOString().slice(0, 10)}`;
}

/** A server's campaign and its table-knowledge channels, if it has a campaign. */
export async function getChannelSettingsForGuild(
  guildId: string,
): Promise<(ChannelSettings & { campaignId: string }) | null> {
  return prisma.campaignDiscord.findUnique({
    where: { guildId },
    select: {
      campaignId: true,
      factsChannelId: true,
      recapsChannelId: true,
      loreChannelId: true,
    },
  });
}

export interface ChannelPost {
  campaignId: string;
  kind: ChannelKind;
  messageId: string;
  authorName: string;
  content: string;
  postedAt: Date;
}

/** Add a post to the memory or refresh it after an edit. A post edited down to nothing is
 * removed instead. */
export function syncChannelPost(post: ChannelPost): Promise<SyncOutcome> {
  return syncExternalDocument({
    campaignId: post.campaignId,
    externalId: post.messageId,
    sourceType: "DISCORD",
    name: channelDocumentName(post.kind, post.authorName, post.postedAt),
    text: post.content,
    fileStem: `discord-${post.messageId}`,
    // Table knowledge: everyone at the table can read the channel.
    baseVisibility: "EVERYONE",
    extractUnits: true,
  });
}

/** Take a deleted post out of the memory. True if it was there. */
export function removeChannelPost(
  campaignId: string,
  messageId: string,
): Promise<boolean> {
  return removeExternalDocument(campaignId, messageId);
}
