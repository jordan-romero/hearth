-- CreateTable
CREATE TABLE "CampaignDiscord" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "revealChannelId" TEXT,
    "voiceChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDiscord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDiscord_campaignId_key" ON "CampaignDiscord"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDiscord_guildId_key" ON "CampaignDiscord"("guildId");

-- AddForeignKey
ALTER TABLE "CampaignDiscord" ADD CONSTRAINT "CampaignDiscord_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
