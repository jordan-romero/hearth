-- DM-added characters (docs/notes-feel.md §2.1): the DM can add a character from the web before
-- its player joins; the player's /join with the same name claims it. Additive only.

-- AlterTable
ALTER TABLE "Character" ALTER COLUMN "membershipId" DROP NOT NULL;
