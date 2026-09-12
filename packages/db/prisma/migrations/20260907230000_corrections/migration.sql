-- CreateEnum
CREATE TYPE "CorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "KnowledgeSource" ADD VALUE 'CORRECTION';

-- AlterTable
ALTER TABLE "KnowledgeUnit" ADD COLUMN "supersededByCorrectionId" TEXT;

-- CreateTable
CREATE TABLE "Correction" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "statement" TEXT NOT NULL,
    "wasWrong" TEXT,
    "proposedByMembershipId" TEXT NOT NULL,
    "reviewedByMembershipId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "resultUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Correction_resultUnitId_key" ON "Correction"("resultUnitId");

-- CreateIndex
CREATE INDEX "Correction_campaignId_status_idx" ON "Correction"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Correction_proposedByMembershipId_idx" ON "Correction"("proposedByMembershipId");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_supersededByCorrectionId_idx" ON "KnowledgeUnit"("supersededByCorrectionId");

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_proposedByMembershipId_fkey" FOREIGN KEY ("proposedByMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_resultUnitId_fkey" FOREIGN KEY ("resultUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_supersededByCorrectionId_fkey" FOREIGN KEY ("supersededByCorrectionId") REFERENCES "Correction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
