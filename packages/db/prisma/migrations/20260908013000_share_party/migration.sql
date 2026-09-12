-- Resolve the audience when the share is requested, so the DM approves exactly the audience
-- they were shown rather than whatever the sharer's party happens to be at approval time.

-- AlterTable
ALTER TABLE "ShareRequest" ADD COLUMN "partyId" TEXT;

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
