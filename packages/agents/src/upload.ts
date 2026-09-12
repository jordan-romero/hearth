// Adding a document to the campaign memory.
//
// Shared by the bot's /upload and the web library so the two can't drift: same storage layout,
// same default visibility, same ingestion job. Presentation differs per adapter; this doesn't.
//
// Everything ingested here is the DM's material and lands DM_ONLY — a document is never
// readable by players until the DM reveals it. Callers MUST enforce the DM check themselves;
// this function deliberately takes a campaign, not a viewer, because the worker also uses it.

import { prisma } from "@hearth/db";
import { putDocument } from "./storage.js";
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

export interface UploadResult {
  documentId: string;
  name: string;
}

/**
 * Store a document and queue it for parse → chunk → embed.
 *
 * `extractUnits` also pulls structured facts (NPCs, places…) out of it with a Claude call —
 * on for a single deliberate upload, off for bulk syncs where that cost multiplies.
 */
export async function ingestUpload(
  campaignId: string,
  fileName: string,
  data: Buffer,
  mimeType?: string,
  extractUnits = true,
): Promise<UploadResult> {
  const doc = await prisma.sourceDocument.create({
    data: {
      campaignId,
      name: fileName,
      sourceType: "UPLOAD",
      mimeType: mimeType ?? null,
      status: "PENDING",
      extractUnits,
    },
  });

  // Everything after the row exists can fail — storage, the queue connection, the enqueue.
  // Without this the document sits at "queued" forever and the library lies about it, so mark
  // it FAILED before rethrowing and let the caller report the real error.
  try {
    // Tenant-scoped key: {campaignId}/{docId}/{safe-name}. The campaign prefix keeps one
    // table's material from ever colliding with another's in the bucket.
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${campaignId}/${doc.id}/${safeName}`;
    await putDocument(key, data, mimeType);
    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { storagePath: key },
    });

    const boss = await getQueue();
    const job: IngestJob = { sourceDocumentId: doc.id };
    await boss.send(INGEST_QUEUE, job);
  } catch (err) {
    await prisma.sourceDocument
      .update({ where: { id: doc.id }, data: { status: "FAILED" } })
      .catch(() => {});
    throw err;
  }

  return { documentId: doc.id, name: fileName };
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
      createdAt: true,
      _count: { select: { chunks: true, knowledgeUnits: true } },
    },
  });
}
