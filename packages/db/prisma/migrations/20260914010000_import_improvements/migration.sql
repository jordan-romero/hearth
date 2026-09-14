-- Bringing an already-running campaign into Hearth.
--   SourceDocument.baseVisibility: a DM can mark an upload as something the players already have.
--   SourceDocument.contentHash:    recognise a file that's already in the campaign's library.
--   Campaign.firstSessionNumber:   start session numbering where the campaign already is.
-- Every column has a default or is nullable, so existing rows and a bot still running the
-- previous release keep today's behaviour.

-- AlterTable
ALTER TABLE "SourceDocument" ADD COLUMN "baseVisibility" "BaseVisibility" NOT NULL DEFAULT 'DM_ONLY',
ADD COLUMN "contentHash" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "firstSessionNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "SourceDocument_campaignId_contentHash_idx" ON "SourceDocument"("campaignId", "contentHash");
