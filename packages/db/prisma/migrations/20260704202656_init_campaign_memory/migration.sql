-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('DM', 'PLAYER');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('SESSION', 'DM_ADDED');

-- CreateEnum
CREATE TYPE "KnowledgeOrigin" AS ENUM ('PLAYED', 'AUTHORED', 'GENERATED');

-- CreateEnum
CREATE TYPE "BaseVisibility" AS ENUM ('DM_ONLY', 'EVERYONE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('NPC', 'LOCATION', 'EVENT', 'FACT', 'LORE', 'ITEM', 'RELATIONSHIP', 'THREAD');

-- CreateEnum
CREATE TYPE "GrantScope" AS ENUM ('CHARACTER', 'PARTY');

-- CreateEnum
CREATE TYPE "RevealAction" AS ENUM ('REVEAL', 'REVOKE', 'CHANGE_VISIBILITY');

-- CreateEnum
CREATE TYPE "CharacterStatus" AS ENUM ('ACTIVE', 'RETIRED', 'DEAD');

-- CreateEnum
CREATE TYPE "GameSessionStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETE');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'firelight',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "partyId" TEXT,
    "name" TEXT NOT NULL,
    "ancestry" TEXT,
    "class" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "pronouns" TEXT,
    "status" "CharacterStatus" NOT NULL DEFAULT 'ACTIVE',
    "avatarUrl" TEXT,
    "bio" TEXT,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSession" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,
    "occurredAt" TIMESTAMP(3),
    "status" "GameSessionStatus" NOT NULL DEFAULT 'COMPLETE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeUnit" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "KnowledgeType" NOT NULL,
    "source" "KnowledgeSource" NOT NULL,
    "origin" "KnowledgeOrigin" NOT NULL DEFAULT 'PLAYED',
    "baseVisibility" "BaseVisibility" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "gameSessionId" TEXT,
    "subjectId" TEXT,
    "objectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGrant" (
    "id" TEXT NOT NULL,
    "knowledgeUnitId" TEXT NOT NULL,
    "scope" "GrantScope" NOT NULL,
    "characterId" TEXT,
    "partyId" TEXT,
    "revealedByMembershipId" TEXT NOT NULL,
    "revealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevealEvent" (
    "id" TEXT NOT NULL,
    "knowledgeUnitId" TEXT NOT NULL,
    "action" "RevealAction" NOT NULL,
    "scope" "GrantScope",
    "characterId" TEXT,
    "partyId" TEXT,
    "fromVisibility" "BaseVisibility",
    "toVisibility" "BaseVisibility",
    "byMembershipId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_campaignId_idx" ON "Membership"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_campaignId_key" ON "Membership"("userId", "campaignId");

-- CreateIndex
CREATE INDEX "Party_campaignId_idx" ON "Party"("campaignId");

-- CreateIndex
CREATE INDEX "Character_campaignId_idx" ON "Character"("campaignId");

-- CreateIndex
CREATE INDEX "Character_membershipId_idx" ON "Character"("membershipId");

-- CreateIndex
CREATE INDEX "Character_partyId_idx" ON "Character"("partyId");

-- CreateIndex
CREATE INDEX "GameSession_campaignId_idx" ON "GameSession"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "GameSession_campaignId_number_key" ON "GameSession"("campaignId", "number");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_campaignId_baseVisibility_idx" ON "KnowledgeUnit"("campaignId", "baseVisibility");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_campaignId_type_idx" ON "KnowledgeUnit"("campaignId", "type");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_gameSessionId_idx" ON "KnowledgeUnit"("gameSessionId");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_subjectId_idx" ON "KnowledgeUnit"("subjectId");

-- CreateIndex
CREATE INDEX "KnowledgeUnit_objectId_idx" ON "KnowledgeUnit"("objectId");

-- CreateIndex
CREATE INDEX "KnowledgeGrant_knowledgeUnitId_idx" ON "KnowledgeGrant"("knowledgeUnitId");

-- CreateIndex
CREATE INDEX "KnowledgeGrant_characterId_idx" ON "KnowledgeGrant"("characterId");

-- CreateIndex
CREATE INDEX "KnowledgeGrant_partyId_idx" ON "KnowledgeGrant"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_knowledgeUnitId_characterId_key" ON "KnowledgeGrant"("knowledgeUnitId", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGrant_knowledgeUnitId_partyId_key" ON "KnowledgeGrant"("knowledgeUnitId", "partyId");

-- CreateIndex
CREATE INDEX "RevealEvent_knowledgeUnitId_idx" ON "RevealEvent"("knowledgeUnitId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "KnowledgeUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnit" ADD CONSTRAINT "KnowledgeUnit_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_knowledgeUnitId_fkey" FOREIGN KEY ("knowledgeUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGrant" ADD CONSTRAINT "KnowledgeGrant_revealedByMembershipId_fkey" FOREIGN KEY ("revealedByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_knowledgeUnitId_fkey" FOREIGN KEY ("knowledgeUnitId") REFERENCES "KnowledgeUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealEvent" ADD CONSTRAINT "RevealEvent_byMembershipId_fkey" FOREIGN KEY ("byMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
