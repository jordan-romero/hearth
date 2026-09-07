-- /ask retrieves document passages as well as facts, so a correction has to be able to retire
-- a wrong passage too — otherwise the original upload keeps grounding the old answer.

-- AlterTable
ALTER TABLE "DocumentChunk" ADD COLUMN "supersededByCorrectionId" TEXT;

-- CreateIndex
CREATE INDEX "DocumentChunk_supersededByCorrectionId_idx" ON "DocumentChunk"("supersededByCorrectionId");
