-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ShareRequest" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "knowledgeUnitId" TEXT NOT NULL,
    "status" "ShareStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "proposedByMembershipId" TEXT,
    "reviewedByMembershipId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShareRequest_campaignId_status_idx" ON "ShareRequest"("campaignId", "status");

-- CreateIndex
CREATE INDEX "ShareRequest_knowledgeUnitId_idx" ON "ShareRequest"("knowledgeUnitId");

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_knowledgeUnitId_fkey" FOREIGN KEY ("knowledgeUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_proposedByMembershipId_fkey" FOREIGN KEY ("proposedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
