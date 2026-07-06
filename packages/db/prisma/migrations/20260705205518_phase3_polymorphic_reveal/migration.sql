-- AlterTable
ALTER TABLE "KnowledgeGrant" ADD COLUMN     "documentChunkId" TEXT,
ADD COLUMN     "sourceDocumentId" TEXT,
ALTER COLUMN "knowledgeUnitId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RevealEvent" ADD COLUMN     "documentChunkId" TEXT,
ADD COLUMN     "sourceDocumentId" TEXT,
ALTER COLUMN "knowledgeUnitId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "KnowledgeGrant_documentChunkId_idx" ON "KnowledgeGrant"("documentChunkId");

-- CreateIndex
CREATE INDEX "KnowledgeGrant_sourceDocumentId_idx" ON "KnowledgeGrant"("sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_documentChunkId_characterId_key" ON "KnowledgeGrant"("documentChunkId", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_documentChunkId_partyId_key" ON "KnowledgeGrant"("documentChunkId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_sourceDocumentId_characterId_key" ON "KnowledgeGrant"("sourceDocumentId", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_sourceDocumentId_partyId_key" ON "KnowledgeGrant"("sourceDocumentId", "partyId");

-- CreateIndex
CREATE INDEX "RevealEvent_documentChunkId_idx" ON "RevealEvent"("documentChunkId");

-- CreateIndex
CREATE INDEX "RevealEvent_sourceDocumentId_idx" ON "RevealEvent"("sourceDocumentId");

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

