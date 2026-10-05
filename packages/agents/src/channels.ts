// Channels a DM designates as table knowledge: permanent facts, player recaps, lore. Every post
// becomes its own document, visible to everyone, keyed by its Discord message id so an edit
// re-reads it and a delete takes it (passages, facts, stored text) out of the memory. It goes
// through the same ingestion as an upload, so secrets in a post are still held apart.

import { createHash } from "node:crypto";
import { prisma } from "@hearth/db";
import { deleteObject, putDocument, DOCUMENTS_BUCKET } from "./storage.js";
import { getQueue } from "./queue.js";
import { INGEST_QUEUE, type IngestJob } from "./jobs.js";

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

export type SyncOutcome = "added" | "updated" | "unchanged" | "removed";

/** Add a post to the memory or refresh it after an edit. A post edited down to nothing is
 * removed instead. */
export async function syncChannelPost(post: ChannelPost): Promise<SyncOutcome> {
  const text = post.content.trim();
  if (!text) {
    const removed = await removeChannelPost(post.campaignId, post.messageId);
    return removed ? "removed" : "unchanged";
  }

  const name = channelDocumentName(post.kind, post.authorName, post.postedAt);
  const data = Buffer.from(`# ${name}\n\n${text}\n`, "utf8");
  const contentHash = createHash("sha256").update(data).digest("hex");

  const existing = await prisma.sourceDocument.findUnique({
    where: {
      campaignId_externalId: {
        campaignId: post.campaignId,
        externalId: post.messageId,
      },
    },
    select: { id: true, contentHash: true },
  });
  // Discord also sends an update when only an embed or a pin changes; nothing to re-read.
  if (existing?.contentHash === contentHash) return "unchanged";

  const doc = existing
    ? await prisma.sourceDocument.update({
        where: { id: existing.id },
        data: { name, contentHash, status: "PENDING" },
        select: { id: true },
      })
    : await prisma.sourceDocument.create({
        data: {
          campaignId: post.campaignId,
          name,
          sourceType: "DISCORD",
          externalId: post.messageId,
          mimeType: "text/markdown",
          status: "PENDING",
          extractUnits: true,
          baseVisibility: "EVERYONE",
          contentHash,
        },
        select: { id: true },
      });

  try {
    const key = `${post.campaignId}/${doc.id}/discord-${post.messageId}.md`;
    await putDocument(key, data, "text/markdown");
    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { storagePath: key },
    });
    const job: IngestJob = { sourceDocumentId: doc.id };
    await (await getQueue()).send(INGEST_QUEUE, job);
  } catch (err) {
    await prisma.sourceDocument
      .update({ where: { id: doc.id }, data: { status: "FAILED" } })
      .catch(() => {});
    throw err;
  }
  return existing ? "updated" : "added";
}

/** Take a deleted post out of the memory: its document, passages, facts, and stored text.
 * True if it was there. */
export async function removeChannelPost(
  campaignId: string,
  messageId: string,
): Promise<boolean> {
  const doc = await prisma.sourceDocument.findUnique({
    where: { campaignId_externalId: { campaignId, externalId: messageId } },
    select: { id: true, storagePath: true },
  });
  if (!doc) return false;
  await prisma.sourceDocument.delete({ where: { id: doc.id } });
  if (doc.storagePath) {
    // The post is gone from Discord; its text shouldn't outlive it in storage.
    await deleteObject(DOCUMENTS_BUCKET, doc.storagePath).catch((err) =>
      console.error(`removing stored post ${doc.storagePath} failed:`, err),
    );
  }
  return true;
}
