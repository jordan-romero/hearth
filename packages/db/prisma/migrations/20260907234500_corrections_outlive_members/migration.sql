-- A correction must outlive the member who proposed it: cascading would delete the correction
-- when a player leaves, which sets its superseded units back to live and resurrects facts the
-- table already disowned.

-- DropForeignKey
ALTER TABLE "Correction" DROP CONSTRAINT "Correction_proposedByMembershipId_fkey";

-- AlterTable
ALTER TABLE "Correction" ALTER COLUMN "proposedByMembershipId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Correction" ADD CONSTRAINT "Correction_proposedByMembershipId_fkey" FOREIGN KEY ("proposedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
