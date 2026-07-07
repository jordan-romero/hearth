-- AlterEnum
ALTER TYPE "KnowledgeSource" ADD VALUE 'PLAYER_NOTE';

-- AlterTable
ALTER TABLE "KnowledgeUnit" ADD COLUMN "authorMembershipId" TEXT;

-- CreateIndex
CREATE INDEX "KnowledgeUnit_authorMembershipId_idx" ON "KnowledgeUnit"("authorMembershipId");

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_authorMembershipId_fkey" FOREIGN KEY ("authorMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
