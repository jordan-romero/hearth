-- Canon vs working, and page highlights as knowledge (docs/workspace.md §1-2), plus the colors
-- the DM gives characters and the table. Additive: new columns with defaults that keep every
-- existing unit canon, so nothing anyone can see changes.

-- CreateEnum
CREATE TYPE "CanonState" AS ENUM ('WORKING', 'CANON');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "tableColor" TEXT;

-- AlterTable
ALTER TABLE "Character" ADD COLUMN     "color" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeUnit" ADD COLUMN     "canon" "CanonState" NOT NULL DEFAULT 'CANON',
ADD COLUMN     "highlightId" TEXT,
ADD COLUMN     "sourcePageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeUnit_highlightId_key" ON "KnowledgeUnit"("highlightId");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_sourcePageId_idx" ON "KnowledgeUnit"("sourcePageId");

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_sourcePageId_fkey" FOREIGN KEY ("sourcePageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

