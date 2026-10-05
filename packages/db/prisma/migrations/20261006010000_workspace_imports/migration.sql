-- One-time imports into the workspace (docs/workspace.md §5): an import record, and on each
-- folder and page the import that made it, plus the imported file's hash and original.
-- Additive only.

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('FILES', 'ONENOTE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('RUNNING', 'DONE');

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "importHash" TEXT,
ADD COLUMN     "originalFileName" TEXT,
ADD COLUMN     "originalFilePath" TEXT;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "destinationFolderId" TEXT,
    "label" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'RUNNING',
    "pagesCreated" INTEGER NOT NULL DEFAULT 0,
    "filesSkipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_campaignId_createdAt_idx" ON "ImportBatch"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "Page_campaignId_importHash_idx" ON "Page"("campaignId", "importHash");

-- CreateIndex
CREATE INDEX "Page_importBatchId_idx" ON "Page"("importBatchId");

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

