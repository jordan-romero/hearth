-- Page links (docs/notes-feel.md §2.2): which workspace page links to which, for backlinks.
-- Additive only.

-- CreateTable
CREATE TABLE "PageLink" (
    "fromPageId" TEXT NOT NULL,
    "toPageId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageLink_pkey" PRIMARY KEY ("fromPageId","toPageId")
);

-- CreateIndex
CREATE INDEX "PageLink_toPageId_idx" ON "PageLink"("toPageId");

-- AddForeignKey
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_toPageId_fkey" FOREIGN KEY ("toPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
