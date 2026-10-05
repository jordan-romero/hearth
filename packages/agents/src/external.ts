// Documents kept in step with something that isn't an upload — a post in a table-knowledge
// channel, a page written in the workspace. Each is keyed by its id there (`externalId`), so a
// change re-reads the same document instead of adding another, and a deletion takes it (passages,
// facts, stored text) out of the memory. They go through the same ingestion as an upload, so secrets inside
// are still held apart.
//
// Name-based versioning never applies to them (see previousVersionsWhere): their names can repeat.

import { createHash } from "node:crypto";
import { prisma, type BaseVisibility, type SourceType } from "@hearth/db";
import { deleteObject, putDocument, DOCUMENTS_BUCKET } from "./storage.js";
import { getQueue } from "./queue.js";
import { INGEST_QUEUE, type IngestJob } from "./jobs.js";

export interface ExternalDocument {
  campaignId: string;
  externalId: string;
  sourceType: SourceType;
  /** How it's named in the library. */
  name: string;
  /** Its text, as markdown. Empty means it's gone. */
  text: string;
  /** Used in the stored file's name, e.g. "discord-123" → ".../discord-123.md". */
  fileStem: string;
  baseVisibility: BaseVisibility;
  extractUnits: boolean;
}

export type SyncOutcome = "added" | "updated" | "unchanged" | "removed";

/** Add a document or refresh it after a change. One whose text is now empty is removed. */
export async function syncExternalDocument(
  doc: ExternalDocument,
): Promise<SyncOutcome> {
  const text = doc.text.trim();
  if (!text) {
    const removed = await removeExternalDocument(
      doc.campaignId,
      doc.externalId,
    );
    return removed ? "removed" : "unchanged";
  }

  const data = Buffer.from(`# ${doc.name}\n\n${text}\n`, "utf8");
  const contentHash = createHash("sha256").update(data).digest("hex");

  const existing = await prisma.sourceDocument.findUnique({
    where: {
      campaignId_externalId: {
        campaignId: doc.campaignId,
        externalId: doc.externalId,
      },
    },
    select: { id: true, contentHash: true },
  });
  // A change that didn't touch the text (a Discord embed or pin, a page saved with no edits)
  // has nothing new to read.
  if (existing?.contentHash === contentHash) return "unchanged";

  const row = existing
    ? await prisma.sourceDocument.update({
        where: { id: existing.id },
        data: {
          name: doc.name,
          contentHash,
          status: "PENDING",
        },
        select: { id: true },
      })
    : await prisma.sourceDocument.create({
        data: {
          campaignId: doc.campaignId,
          name: doc.name,
          sourceType: doc.sourceType,
          externalId: doc.externalId,
          mimeType: "text/markdown",
          status: "PENDING",
          extractUnits: doc.extractUnits,
          baseVisibility: doc.baseVisibility,
          contentHash,
        },
        select: { id: true },
      });

  try {
    const key = `${doc.campaignId}/${row.id}/${doc.fileStem}.md`;
    await putDocument(key, data, "text/markdown");
    await prisma.sourceDocument.update({
      where: { id: row.id },
      data: { storagePath: key },
    });
    const job: IngestJob = { sourceDocumentId: row.id };
    await (await getQueue()).send(INGEST_QUEUE, job);
  } catch (err) {
    await prisma.sourceDocument
      .update({ where: { id: row.id }, data: { status: "FAILED" } })
      .catch(() => {});
    throw err;
  }
  return existing ? "updated" : "added";
}

/** Take a document whose source is gone out of the memory: the document, its passages, facts,
 * and stored text. True if it was there. */
export async function removeExternalDocument(
  campaignId: string,
  externalId: string,
): Promise<boolean> {
  const doc = await prisma.sourceDocument.findUnique({
    where: { campaignId_externalId: { campaignId, externalId } },
    select: { id: true, storagePath: true },
  });
  if (!doc) return false;
  await prisma.sourceDocument.delete({ where: { id: doc.id } });
  if (doc.storagePath) {
    // It's gone at the source; its text shouldn't outlive it in storage.
    await deleteObject(DOCUMENTS_BUCKET, doc.storagePath).catch((err) =>
      console.error(`removing stored document ${doc.storagePath} failed:`, err),
    );
  }
  return true;
}
