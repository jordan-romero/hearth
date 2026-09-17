// The ingestion pipeline: a stored SourceDocument → parsed text → chunks → embedded
// DocumentChunks (the RAG layer). Idempotent — re-ingesting a doc replaces its chunks.
// Chunks and extracted facts take the document's visibility: DM_ONLY by default, EVERYONE when
// the DM marked it as something the players already have.

import { prisma } from "@hearth/db";
import { getDocument } from "./storage.js";
import { extractText } from "./parse.js";
import { chunkText } from "./chunk.js";
import { linkFactsForDocument } from "./link-sources.js";
import { buildGraph, documentSource } from "./graph-build.js";
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
          baseVisibility: doc.baseVisibility,
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
        await extractUnitsForDoc(
          doc.id,
          doc.campaignId,
          text,
          doc.baseVisibility,
        );
      } catch (err) {
        console.error(`[ingest] unit extraction failed for ${doc.id}:`, err);
      }
      // Trace each new fact to the exact words it came from. A fact that can't be traced is marked
      // UNSOURCED and not used. Separate from extraction and never fatal: if linking fails, the
      // facts stay UNCHECKED — usable, as every fact was before sources existed.
      try {
        const linked = await linkFactsForDocument(doc.id);
        console.log(
          `[ingest] sources for ${doc.id}: facts=${linked.facts} sourced=${linked.sourced} ` +
            `unsourced=${linked.unsourced} unchecked=${linked.unchecked}`,
        );
      } catch (err) {
        console.error(`[ingest] source linking failed for ${doc.id}:`, err);
      }
    }

    // Add this document's people, places and connections to the campaign graph. Never fatal: the
    // document is fully usable without it, and a later rebuild picks it up.
    try {
      const graph = await buildGraph(doc.campaignId, [
        await documentSource(doc.id),
      ]);
      console.log(
        `[ingest] graph from ${doc.id}: entities=${graph.entitiesTotal} relations=${graph.relations} ` +
          `failedWindows=${graph.failedWindows}`,
      );
    } catch (err) {
      console.error(`[ingest] graph build failed for ${doc.id}:`, err);
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

/** Distill a document's text into structured DM_ADDED KnowledgeUnits, linked back to the doc
 * for provenance and visible to whoever the doc is. Idempotent — replaces this doc's
 * DM_ADDED units. */
async function extractUnitsForDoc(
  sourceDocumentId: string,
  campaignId: string,
  text: string,
  baseVisibility: "DM_ONLY" | "EVERYONE" | "PUBLIC",
): Promise<void> {
  const units = await extractUnitsFromText(text);
  const created = await prisma.$transaction(async (tx) => {
    // Secrets carry the same sourceDocumentId, so a re-ingest replaces them along with the facts.
    await tx.knowledgeUnit.deleteMany({
      where: { sourceDocumentId, source: "DM_ADDED" },
    });
    if (units.length === 0) return [];
    const facts = await tx.knowledgeUnit.createManyAndReturn({
      data: units.map((u) => ({
        campaignId,
        sourceDocumentId,
        type: u.type,
        source: "DM_ADDED" as const,
        origin: "AUTHORED" as const,
        baseVisibility,
        title: u.title,
        content: u.content,
      })),
    });
    // What only the DM should know is its own DM_ONLY unit linked to the fact — even in a
    // document the players already have — so revealing the fact can never carry the secret.
    const factIdByTitle = new Map(facts.map((f) => [f.title, f.id]));
    const secretRows = units.flatMap((u) =>
      u.secret
        ? [
            {
              campaignId,
              sourceDocumentId,
              type: "FACT" as const,
              source: "DM_ADDED" as const,
              origin: "AUTHORED" as const,
              baseVisibility: "DM_ONLY" as const,
              title: `Secret — ${u.title}`,
              content: u.secret,
              subjectId: factIdByTitle.get(u.title) ?? null,
            },
          ]
        : [],
    );
    const secrets =
      secretRows.length > 0
        ? await tx.knowledgeUnit.createManyAndReturn({ data: secretRows })
        : [];
    return [...facts, ...secrets];
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
