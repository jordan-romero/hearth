-- Where each fact was found.
--   FactSource:                     a fact → the passage it came from, with the exact supporting words.
--   KnowledgeUnit.provenance:       UNCHECKED / SOURCED / UNSOURCED. An UNSOURCED document fact
--                                   couldn't be traced to its source and is not used.
-- Purely additive: no existing fact or passage is touched, so no reveal (KnowledgeGrant cascades
-- from both) can be lost, and a bot still running the previous release never reads these.

-- CreateEnum
CREATE TYPE "FactProvenance" AS ENUM ('UNCHECKED', 'SOURCED', 'UNSOURCED');

-- AlterTable
ALTER TABLE "KnowledgeUnit" ADD COLUMN     "provenance" "FactProvenance" NOT NULL DEFAULT 'UNCHECKED';

-- CreateTable
CREATE TABLE "FactSource" (
    "id" TEXT NOT NULL,
    "knowledgeUnitId" TEXT NOT NULL,
    "documentChunkId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FactSource_documentChunkId_idx" ON "FactSource"("documentChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "FactSource_knowledgeUnitId_documentChunkId_key" ON "FactSource"("knowledgeUnitId", "documentChunkId");

-- AddForeignKey
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_knowledgeUnitId_fkey" FOREIGN KEY ("knowledgeUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
