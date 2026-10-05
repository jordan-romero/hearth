-- OneNote import: a DM connects a Microsoft account and picks sections; each page becomes a
-- library document keyed by its page id. Additive only — a nullable column and a new table — so
-- the running bot and worker are unaffected until they deploy code that uses them.

-- AlterTable
ALTER TABLE "SourceDocument" ADD COLUMN     "externalVersion" TEXT;

-- CreateTable
CREATE TABLE "OneNoteConnection" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "connectedByMembershipId" TEXT NOT NULL,
    "accountName" TEXT,
    "refreshTokenEnc" TEXT NOT NULL,
    "sectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extractUnits" BOOLEAN NOT NULL DEFAULT true,
    "syncing" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneNoteConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OneNoteConnection_campaignId_key" ON "OneNoteConnection"("campaignId");

-- AddForeignKey
ALTER TABLE "OneNoteConnection" ADD CONSTRAINT "OneNoteConnection_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

