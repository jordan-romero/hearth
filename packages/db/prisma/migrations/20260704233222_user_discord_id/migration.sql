-- Link a Discord account to a person (bot identity resolution).
ALTER TABLE "User" ADD COLUMN "discordUserId" TEXT;
CREATE UNIQUE INDEX "User_discordUserId_key" ON "User"("discordUserId");
