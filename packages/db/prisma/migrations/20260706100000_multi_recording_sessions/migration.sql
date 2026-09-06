-- DropIndex (a session can now have MANY recordings — one per stop/restart segment)
DROP INDEX "Recording_gameSessionId_key";

-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN "lastActivityAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Recording_gameSessionId_idx" ON "Recording"("gameSessionId");
