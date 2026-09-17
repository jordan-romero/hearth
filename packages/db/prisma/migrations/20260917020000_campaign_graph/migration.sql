-- The campaign graph: entities (people, places, factions, items, creatures) with aliases, relationships
-- between them backed by verified quotes, and which facts and passages each entity appears in.
-- Purely additive: no existing table is altered beyond new relations, so nothing that exists can be
-- lost, and a bot still running the previous release never reads these tables.



-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('PERSON', 'PLACE', 'FACTION', 'ITEM', 'CREATURE', 'OTHER');

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "EntityKind" NOT NULL,
    "name" TEXT NOT NULL,
    "characterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityAlias" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,

    CONSTRAINT "EntityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityRelation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationSource" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "documentChunkId" TEXT,
    "transcriptSegmentId" TEXT,
    "quote" TEXT NOT NULL,

    CONSTRAINT "RelationSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactEntity" (
    "knowledgeUnitId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,

    CONSTRAINT "FactEntity_pkey" PRIMARY KEY ("knowledgeUnitId","entityId")
);

-- CreateTable
CREATE TABLE "EntityMention" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentChunkId" TEXT,
    "transcriptSegmentId" TEXT,

    CONSTRAINT "EntityMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_characterId_key" ON "Entity"("characterId");

-- CreateIndex
CREATE INDEX "Entity_campaignId_idx" ON "Entity"("campaignId");

-- CreateIndex
CREATE INDEX "EntityAlias_campaignId_normalized_idx" ON "EntityAlias"("campaignId", "normalized");

-- CreateIndex
CREATE UNIQUE INDEX "EntityAlias_entityId_normalized_key" ON "EntityAlias"("entityId", "normalized");

-- CreateIndex
CREATE INDEX "EntityRelation_campaignId_idx" ON "EntityRelation"("campaignId");

-- CreateIndex
CREATE INDEX "EntityRelation_objectId_idx" ON "EntityRelation"("objectId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityRelation_subjectId_relation_objectId_key" ON "EntityRelation"("subjectId", "relation", "objectId");

-- CreateIndex
CREATE INDEX "RelationSource_documentChunkId_idx" ON "RelationSource"("documentChunkId");

-- CreateIndex
CREATE INDEX "RelationSource_transcriptSegmentId_idx" ON "RelationSource"("transcriptSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationSource_relationId_documentChunkId_key" ON "RelationSource"("relationId", "documentChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationSource_relationId_transcriptSegmentId_key" ON "RelationSource"("relationId", "transcriptSegmentId");

-- CreateIndex
CREATE INDEX "FactEntity_entityId_idx" ON "FactEntity"("entityId");

-- CreateIndex
CREATE INDEX "EntityMention_documentChunkId_idx" ON "EntityMention"("documentChunkId");

-- CreateIndex
CREATE INDEX "EntityMention_transcriptSegmentId_idx" ON "EntityMention"("transcriptSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityMention_entityId_documentChunkId_key" ON "EntityMention"("entityId", "documentChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityMention_entityId_transcriptSegmentId_key" ON "EntityMention"("entityId", "transcriptSegmentId");

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityAlias" ADD CONSTRAINT "EntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelation" ADD CONSTRAINT "EntityRelation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelation" ADD CONSTRAINT "EntityRelation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelation" ADD CONSTRAINT "EntityRelation_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationSource" ADD CONSTRAINT "RelationSource_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "EntityRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationSource" ADD CONSTRAINT "RelationSource_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationSource" ADD CONSTRAINT "RelationSource_transcriptSegmentId_fkey" FOREIGN KEY ("transcriptSegmentId") REFERENCES "TranscriptSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactEntity" ADD CONSTRAINT "FactEntity_knowledgeUnitId_fkey" FOREIGN KEY ("knowledgeUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactEntity" ADD CONSTRAINT "FactEntity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_transcriptSegmentId_fkey" FOREIGN KEY ("transcriptSegmentId") REFERENCES "TranscriptSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

