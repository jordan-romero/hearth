// Adding a document to the campaign memory.
//
// Shared by the bot's /upload and the web library so the two can't drift: same storage layout,
// same default visibility, same ingestion job. Presentation differs per adapter; this doesn't.
//
// Everything ingested here is the DM's material. It lands DM_ONLY — never readable by players
// until the DM reveals it — unless the DM explicitly marks it as something the players already
// have. Callers MUST enforce the DM check themselves; this function deliberately takes a
// campaign, not a viewer, because the worker also uses it.

import { createHash, randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@hearth/db";
import {
  createDocumentUploadUrl,
  getDocument,
  putDocument,
  removeDocumentObject,
} from "./storage.js";
import { getQueue } from "./queue.js";
import { INGEST_QUEUE, type IngestJob } from "./jobs.js";

/** Must match the web action's limit and next.config's serverActions.bodySizeLimit. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Extensions the parser can actually read today (parse.ts). */
export const SUPPORTED_UPLOAD_EXTENSIONS = [
  ".txt",
  ".md",
  ".pdf",
  ".docx",
] as const;

export function isSupportedUpload(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Why a file can't be uploaded, or null if it can. */
export function uploadProblem(fileName: string, size: number): string | null {
  if (!fileName || size <= 0) return "Choose a file first.";
  if (!isSupportedUpload(fileName)) {
    return `Hearth can read ${SUPPORTED_UPLOAD_EXTENSIONS.join(", ")} — not that.`;
  }
  if (size > MAX_UPLOAD_BYTES) {
    return `That file is ${(size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`;
  }
  return null;
}

/** An upload refused for a reason the DM can act on; the message is safe to show them. */
export class UploadRejectedError extends Error {}

export interface UploadResult {
  documentId: string;
  name: string;
  /** True when this exact file was already in the campaign's library, so nothing was added. */
  alreadyAdded: boolean;
  /** Set when a document of this name is already in the library: this upload replaces it once it
   * has been read. The old version is kept for anything already revealed from it. */
  replaces?: { id: string; uploadedAt: Date };
}

const safeName = (fileName: string) =>
  fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

const hashOf = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Where a browser-uploaded document goes: under its campaign, in a folder of its own. */
export function directUploadKey(campaignId: string, fileName: string): string {
  return `${campaignId}/uploads/${randomUUID()}/${safeName(fileName)}`;
}

/** Whether a storage key is one of this campaign's direct uploads. The key comes back from the
 * browser, so this is what stops one campaign ingesting a file stored under another. */
export function isDirectUploadKey(campaignId: string, key: string): boolean {
  const prefix = `${campaignId}/uploads/`;
  if (!campaignId || !key.startsWith(prefix)) return false;
  const parts = key.slice(prefix.length).split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

// The same file twice (a double-click, or sending it again) would import every fact twice.
// A copy that failed doesn't count, so uploading it again retries. Neither does a version the DM
// has since replaced: uploading that file again is how they put the old version back.
function findDuplicate(campaignId: string, contentHash: string) {
  return prisma.sourceDocument.findFirst({
    where: {
      campaignId,
      contentHash,
      status: { not: "FAILED" },
      supersededById: null,
    },
    select: { id: true, name: true },
  });
}

/** The version this upload will replace: the current document of the same name in the same
 * campaign, if there is one. Same name means same document — a DM who edits NPCS.md and uploads
 * it again means "this is the new NPCS.md", not "keep both". */
export async function previousVersion(
  campaignId: string,
  fileName: string,
): Promise<{ id: string; name: string; createdAt: Date } | null> {
  return prisma.sourceDocument.findFirst({
    where: {
      campaignId,
      name: fileName,
      supersededById: null,
      status: { not: "FAILED" },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true },
  });
}

/** Mark earlier uploads of this file as replaced by it. Called once the new version has been read
 * successfully, so a file that fails to parse never retires the version that works.
 *
 * Nothing is deleted. Deleting a document cascades its KnowledgeGrants, so it would silently
 * revoke every reveal granted from the old version; instead the old passages and facts stop being
 * used in answers, reveal offers, search and the graph, and anything already revealed still
 * resolves. Only documents created BEFORE this one are touched, so two uploads racing can never
 * supersede each other and leave the campaign with no current version. */
export async function supersedePreviousVersions(doc: {
  id: string;
  campaignId: string;
  name: string;
  createdAt: Date;
}): Promise<number> {
  const { count } = await prisma.sourceDocument.updateMany({
    where: previousVersionsWhere(doc),
    data: { supersededById: doc.id, supersededAt: new Date() },
  });
  return count;
}

/** Which documents a newly-read upload replaces: same campaign, same file name, not itself, not
 * already replaced, and — the race guard — only ones uploaded BEFORE it. Without that last
 * condition two uploads landing together could each mark the other replaced, leaving the campaign
 * with no current version of the document at all. */
export function previousVersionsWhere(doc: {
  id: string;
  campaignId: string;
  name: string;
  createdAt: Date;
}): Prisma.SourceDocumentWhereInput {
  return {
    campaignId: doc.campaignId,
    name: doc.name,
    id: { not: doc.id },
    supersededById: null,
    createdAt: { lt: doc.createdAt },
  };
}

function createDocument(
  campaignId: string,
  fileName: string,
  mimeType: string | undefined,
  extractUnits: boolean,
  forPlayers: boolean,
  contentHash: string,
) {
  return prisma.sourceDocument.create({
    data: {
      campaignId,
      name: fileName,
      sourceType: "UPLOAD",
      mimeType: mimeType ?? null,
      status: "PENDING",
      extractUnits,
      baseVisibility: forPlayers ? "EVERYONE" : "DM_ONLY",
      contentHash,
    },
    select: { id: true },
  });
}

// Everything after the row exists can fail — storage, the queue connection, the enqueue.
// Without this the document sits at "queued" forever and the library lies about it, so mark it
// FAILED before rethrowing and let the caller report the real error.
async function storeAndQueue(
  documentId: string,
  store: () => Promise<string>,
): Promise<void> {
  try {
    const storagePath = await store();
    await prisma.sourceDocument.update({
      where: { id: documentId },
      data: { storagePath },
    });
    const job: IngestJob = { sourceDocumentId: documentId };
    await (await getQueue()).send(INGEST_QUEUE, job);
  } catch (err) {
    await prisma.sourceDocument
      .update({ where: { id: documentId }, data: { status: "FAILED" } })
      .catch(() => {});
    throw err;
  }
}

/**
 * Store a document and queue it for parse → chunk → embed.
 *
 * `extractUnits` also pulls structured facts (NPCs, places…) out of it with a Claude call —
 * on for a single deliberate upload, off for bulk syncs where that cost multiplies.
 *
 * `forPlayers` marks material the players already have, so its passages and facts are visible
 * to everyone. Off unless the DM explicitly chooses it.
 */
export async function ingestUpload(
  campaignId: string,
  fileName: string,
  data: Buffer,
  mimeType?: string,
  extractUnits = true,
  forPlayers = false,
): Promise<UploadResult> {
  const contentHash = hashOf(data);
  const existing = await findDuplicate(campaignId, contentHash);
  if (existing) {
    return { documentId: existing.id, name: existing.name, alreadyAdded: true };
  }

  const previous = await previousVersion(campaignId, fileName);
  const doc = await createDocument(
    campaignId,
    fileName,
    mimeType,
    extractUnits,
    forPlayers,
    contentHash,
  );
  // Tenant-scoped key: {campaignId}/{docId}/{safe-name}. The campaign prefix keeps one table's
  // material from ever colliding with another's in the bucket.
  await storeAndQueue(doc.id, () =>
    putDocument(
      `${campaignId}/${doc.id}/${safeName(fileName)}`,
      data,
      mimeType,
    ),
  );
  return {
    documentId: doc.id,
    name: fileName,
    alreadyAdded: false,
    ...(previous
      ? { replaces: { id: previous.id, uploadedAt: previous.createdAt } }
      : {}),
  };
}

/** Step one of a direct upload: where the browser should send the file, and its key. */
export async function prepareDirectUpload(
  campaignId: string,
  fileName: string,
): Promise<{ key: string; uploadUrl: string }> {
  const key = directUploadKey(campaignId, fileName);
  return { key, uploadUrl: await createDocumentUploadUrl(key) };
}

/** Step two: the browser has put the file in storage. Read it back and add it like any other
 * upload — checking the size that actually arrived, not the size the browser claimed. */
export async function ingestDirectUpload(
  campaignId: string,
  key: string,
  fileName: string,
  mimeType?: string,
  extractUnits = true,
  forPlayers = false,
): Promise<UploadResult> {
  if (!isDirectUploadKey(campaignId, key)) {
    throw new UploadRejectedError(
      "That upload doesn't belong to this campaign.",
    );
  }
  const data = await getDocument(key);
  const problem = uploadProblem(fileName, data.length);
  if (problem) {
    await removeDocumentObject(key).catch(() => {});
    throw new UploadRejectedError(problem);
  }

  const contentHash = hashOf(data);
  const existing = await findDuplicate(campaignId, contentHash);
  if (existing) {
    await removeDocumentObject(key).catch((err) =>
      console.error(`removing duplicate upload ${key} failed:`, err),
    );
    return { documentId: existing.id, name: existing.name, alreadyAdded: true };
  }

  const previous = await previousVersion(campaignId, fileName);
  const doc = await createDocument(
    campaignId,
    fileName,
    mimeType,
    extractUnits,
    forPlayers,
    contentHash,
  );
  await storeAndQueue(doc.id, async () => key);
  return {
    documentId: doc.id,
    name: fileName,
    alreadyAdded: false,
    ...(previous
      ? { replaces: { id: previous.id, uploadedAt: previous.createdAt } }
      : {}),
  };
}

/** The campaign's documents with how much of the memory each one produced. */
export async function listDocuments(campaignId: string) {
  return prisma.sourceDocument.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      mimeType: true,
      sourceType: true,
      baseVisibility: true,
      createdAt: true,
      supersededById: true,
      supersededAt: true,
      _count: { select: { chunks: true, knowledgeUnits: true } },
    },
  });
}
