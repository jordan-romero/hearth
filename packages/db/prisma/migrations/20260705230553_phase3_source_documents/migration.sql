-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('UPLOAD', 'DISCORD', 'DRIVE', 'NOTION', 'ONENOTE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PARSING', 'PARSED', 'FAILED');

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL DEFAULT 'UPLOAD',
    "storagePath" TEXT,
    "sourceUrl" TEXT,
    "mimeType" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "baseVisibility" "BaseVisibility" NOT NULL DEFAULT 'DM_ONLY',
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceDocument_campaignId_idx" ON "SourceDocument"("campaignId");

-- CreateIndex
CREATE INDEX "DocumentChunk_campaignId_baseVisibility_idx" ON "DocumentChunk"("campaignId", "baseVisibility");

-- CreateIndex
CREATE INDEX "DocumentChunk_sourceDocumentId_idx" ON "DocumentChunk"("sourceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_sourceDocumentId_chunkIndex_key" ON "DocumentChunk"("sourceDocumentId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
