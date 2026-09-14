-- The DM usually has no character, so their pronouns live on the membership. A player's token
-- image is stored privately and referenced by key. Both nullable, so existing rows and a bot
-- still running the previous release are unaffected.

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "pronouns" TEXT;

-- AlterTable
ALTER TABLE "Character" ADD COLUMN "tokenStoragePath" TEXT;
