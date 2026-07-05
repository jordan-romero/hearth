-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('CAPTURING', 'TRANSCRIBING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "gameSessionId" TEXT NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'CAPTURING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "mixStoragePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioClip" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "characterId" TEXT,
    "discordUserId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "codec" TEXT NOT NULL DEFAULT 'opus',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "audioClipId" TEXT,
    "characterId" TEXT,
    "discordUserId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionAttendance" (
    "id" TEXT NOT NULL,
    "gameSessionId" TEXT NOT NULL,
    "characterId" TEXT,
    "discordUserId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "SessionAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recording_gameSessionId_key" ON "Recording"("gameSessionId");

-- CreateIndex
CREATE INDEX "AudioClip_recordingId_idx" ON "AudioClip"("recordingId");

-- CreateIndex
CREATE INDEX "AudioClip_characterId_idx" ON "AudioClip"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_audioClipId_key" ON "TranscriptSegment"("audioClipId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_recordingId_startMs_idx" ON "TranscriptSegment"("recordingId", "startMs");

-- CreateIndex
CREATE INDEX "TranscriptSegment_characterId_idx" ON "TranscriptSegment"("characterId");

-- CreateIndex
CREATE INDEX "SessionAttendance_gameSessionId_idx" ON "SessionAttendance"("gameSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAttendance_gameSessionId_discordUserId_key" ON "SessionAttendance"("gameSessionId", "discordUserId");

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioClip" ADD CONSTRAINT "AudioClip_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioClip" ADD CONSTRAINT "AudioClip_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_audioClipId_fkey" FOREIGN KEY ("audioClipId") REFERENCES "AudioClip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionAttendance" ADD CONSTRAINT "SessionAttendance_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionAttendance" ADD CONSTRAINT "SessionAttendance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
