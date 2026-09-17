-- A session as each character lived it: a summary and an in-character telling, per character.
-- Purely additive.


-- CreateTable
CREATE TABLE "CharacterRecap" (
    "id" TEXT NOT NULL,
    "gameSessionId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "inCharacter" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterRecap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CharacterRecap_characterId_idx" ON "CharacterRecap"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterRecap_gameSessionId_characterId_key" ON "CharacterRecap"("gameSessionId", "characterId");

-- AddForeignKey
ALTER TABLE "CharacterRecap" ADD CONSTRAINT "CharacterRecap_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterRecap" ADD CONSTRAINT "CharacterRecap_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

