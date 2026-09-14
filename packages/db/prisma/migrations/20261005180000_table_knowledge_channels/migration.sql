-- Channels a DM designates as table knowledge: permanent facts, player recaps, lore. Every post in
-- them becomes its own document visible to everyone, keyed by its Discord message id so an edit
-- re-reads it and a delete removes it. All columns are nullable, so existing rows and a bot on the
-- previous release are unaffected.

-- AlterTable
ALTER TABLE "CampaignDiscord" ADD COLUMN "factsChannelId" TEXT,
ADD COLUMN "recapsChannelId" TEXT,
ADD COLUMN "loreChannelId" TEXT;

-- AlterTable
ALTER TABLE "SourceDocument" ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_campaignId_externalId_key" ON "SourceDocument"("campaignId", "externalId");
