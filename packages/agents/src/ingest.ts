// The ingestion pipeline: a stored SourceDocument → parsed text → chunks → embedded
// DocumentChunks (the RAG layer). Idempotent — re-ingesting a doc replaces its chunks.
// Chunks default to DM_ONLY (the schema default); a player-visible source (e.g. a public
// Discord channel) will override that when those connectors land.

import { prisma } from "@hearth/db";
import { getDocument } from "./storage.js";
import { extractText } from "./parse.js";
import { chunkText } from "./chunk.js";
import { embedTexts, toVectorLiteral } from "./embeddings.js";

const EMBED_BATCH = 100; // stay well under Voyage's per-request input cap

export async function ingestDocument(sourceDocumentId: string): Promise<void> {
  const doc = await prisma.sourceDocument.findUnique({
    where: { id: sourceDocumentId },
  });
  if (!doc) {
    console.warn(`[ingest] document ${sourceDocumentId} not found`);
    return;
  }
  if (!doc.storagePath) {
    console.warn(`[ingest] document ${sourceDocumentId} has no stored file`);
    return;
  }

  try {
    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { status: "PARSING" },
    });

    const data = await getDocument(doc.storagePath);
    const text = await extractText(data, doc.mimeType, doc.name);
    const pieces = chunkText(text);

    // Replace this doc's chunks atomically so a re-ingest can't duplicate them.
    const created = await prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({
        where: { sourceDocumentId: doc.id },
      });
      return tx.documentChunk.createManyAndReturn({
        data: pieces.map((chunk, i) => ({
          sourceDocumentId: doc.id,
          campaignId: doc.campaignId,
          chunkIndex: i,
          text: chunk,
        })),
      });
    });

    // Embed in batches, then write each chunk's vector (raw SQL — pgvector).
    for (let i = 0; i < created.length; i += EMBED_BATCH) {
      const batch = created.slice(i, i + EMBED_BATCH);
      const vectors = await embedTexts(
        batch.map((c) => c.text),
        "document",
      );
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (!vec) continue;
        await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${batch[j]!.id}`;
      }
    }

    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { status: "PARSED" },
    });
    console.log(
      `[ingest] "${doc.name}" (${doc.id}): ${created.length} chunks embedded`,
    );
  } catch (err) {
    console.error(`[ingest] document ${sourceDocumentId} failed:`, err);
    await prisma.sourceDocument
      .update({ where: { id: sourceDocumentId }, data: { status: "FAILED" } })
      .catch(() => {});
  }
}
