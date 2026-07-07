-- CreateTable
CREATE TABLE "AskLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "askedByMembershipId" TEXT,
    "characterId" TEXT,
    "role" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "gameSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AskLog_campaignId_createdAt_idx" ON "AskLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AskLog_campaignId_characterId_idx" ON "AskLog"("campaignId", "characterId");

-- AddForeignKey
ALTER TABLE "AskLog" ADD CONSTRAINT "AskLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
