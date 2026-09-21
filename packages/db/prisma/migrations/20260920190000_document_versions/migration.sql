-- A document can be replaced by a newer upload of the same file.
--
-- Additive and nullable: every existing document reads as current. The old version is kept
-- rather than deleted, because deleting a SourceDocument cascades its KnowledgeGrants and would
-- silently revoke reveals players already have.
ALTER TABLE "SourceDocument" ADD COLUMN "supersededById" TEXT;
ALTER TABLE "SourceDocument" ADD COLUMN "supersededAt" TIMESTAMP(3);

CREATE INDEX "SourceDocument_campaignId_supersededById_idx"
  ON "SourceDocument"("campaignId", "supersededById");

-- SetNull: if a newer version is ever deleted, the version it replaced becomes current again
-- instead of vanishing with it.
ALTER TABLE "SourceDocument"
  ADD CONSTRAINT "SourceDocument_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "SourceDocument"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
