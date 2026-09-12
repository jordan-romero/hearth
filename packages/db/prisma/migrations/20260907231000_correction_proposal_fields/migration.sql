-- AlterTable
ALTER TABLE "Correction" ADD COLUMN "targetUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
                         ADD COLUMN "resultTitle" TEXT,
                         ADD COLUMN "resultContent" TEXT;
