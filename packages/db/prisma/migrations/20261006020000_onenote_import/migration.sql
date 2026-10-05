-- OneNote import (docs/workspace.md §5): the DM's connected Microsoft account (refresh token
-- sealed at rest) and a message on imports. Additive only.

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "message" TEXT;

-- CreateTable
CREATE TABLE "OneNoteConnection" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "connectedByMembershipId" TEXT NOT NULL,
    "accountName" TEXT,
    "refreshTokenEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneNoteConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OneNoteConnection_campaignId_key" ON "OneNoteConnection"("campaignId");

-- AddForeignKey
ALTER TABLE "OneNoteConnection" ADD CONSTRAINT "OneNoteConnection_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

