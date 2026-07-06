-- AlterTable
ALTER TABLE "KnowledgeUnit" ADD COLUMN     "sourceDocumentId" TEXT;

-- AlterTable
ALTER TABLE "SourceDocument" ADD COLUMN     "extractUnits" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "KnowledgeUnit_sourceDocumentId_idx" ON "KnowledgeUnit"("sourceDocumentId");

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
