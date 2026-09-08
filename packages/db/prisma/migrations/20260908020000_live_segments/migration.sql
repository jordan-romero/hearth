-- Live segments arrive while a speaker is still talking, so /recap and /npc live can see a
-- monologue before it ends. The batch transcript for the same audio replaces them later.

-- AlterTable
ALTER TABLE "TranscriptSegment" ADD COLUMN "isLive" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "TranscriptSegment_recordingId_discordUserId_isLive_idx" ON "TranscriptSegment"("recordingId", "discordUserId", "isLive");
