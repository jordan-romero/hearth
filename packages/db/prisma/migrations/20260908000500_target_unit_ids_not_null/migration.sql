-- The Prisma schema declares targetUnitIds as a non-null String[], but the migration that added
-- it left the column nullable. Align the database with the schema so a NULL can never reach a
-- client that isn't typed for one.
UPDATE "Correction" SET "targetUnitIds" = ARRAY[]::TEXT[] WHERE "targetUnitIds" IS NULL;
ALTER TABLE "Correction" ALTER COLUMN "targetUnitIds" SET NOT NULL;
