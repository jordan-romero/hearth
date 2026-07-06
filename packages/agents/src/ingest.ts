// The ingestion pipeline: a stored SourceDocument → parsed text → chunks → embedded
// DocumentChunks (the RAG layer). Idempotent — re-ingesting a doc replaces its chunks.
// Chunks default to DM_ONLY (the schema default); a player-visible source (e.g. a public
// Discord channel) will override that when those connectors land.

import { prisma } from "@hearth/db";
import { getDocument } from "./storage.js";
import { extractText } from "./parse.js";
import { chunkText } from "./chunk.js";
import { embedTexts, toVectorLiteral } from "./embeddings.js";
import { extractUnitsFromText } from "./extract.js";

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

    console.log(
      `[ingest] "${doc.name}" (${doc.id}): ${created.length} chunks embedded`,
    );

    // Optionally distill the doc into structured DM_ADDED units (a Claude call). Wrapped
    // so a failed extraction never loses the chunks we already committed.
    if (doc.extractUnits) {
      try {
        await extractUnitsForDoc(doc.id, doc.campaignId, text);
      } catch (err) {
        console.error(`[ingest] unit extraction failed for ${doc.id}:`, err);
      }
    }

    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { status: "PARSED" },
    });
  } catch (err) {
    console.error(`[ingest] document ${sourceDocumentId} failed:`, err);
    await prisma.sourceDocument
      .update({ where: { id: sourceDocumentId }, data: { status: "FAILED" } })
      .catch(() => {});
  }
}

/** Distill a document's text into structured DM_ADDED KnowledgeUnits (DM_ONLY), linked
 * back to the doc for provenance. Idempotent — replaces this doc's DM_ADDED units. */
async function extractUnitsForDoc(
  sourceDocumentId: string,
  campaignId: string,
  text: string,
): Promise<void> {
  const units = await extractUnitsFromText(text);
  const created = await prisma.$transaction(async (tx) => {
    await tx.knowledgeUnit.deleteMany({
      where: { sourceDocumentId, source: "DM_ADDED" },
    });
    if (units.length === 0) return [];
    return tx.knowledgeUnit.createManyAndReturn({
      data: units.map((u) => ({
        campaignId,
        sourceDocumentId,
        type: u.type,
        source: "DM_ADDED" as const,
        origin: "AUTHORED" as const,
        baseVisibility: "DM_ONLY" as const,
        title: u.title,
        content: u.content,
      })),
    });
  });
  if (created.length === 0) return;

  const vectors = await embedTexts(
    created.map((u) => `${u.title}. ${u.content}`),
    "document",
  );
  for (let i = 0; i < created.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${created[i]!.id}`;
  }
  console.log(`[ingest] +${created.length} DM_ADDED units from document`);
}
