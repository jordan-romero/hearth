// Workspace pages as the browser keeps them (workspace/page-store.ts): content, revision and
// backlinks, for the page route and for fetching pages ahead. Callers check the DM first.

import { prisma } from "@hearth/db";
import type { PmNode } from "@hearth/agents";

export interface PageDoc {
  id: string;
  title: string;
  icon: string | null;
  content: PmNode;
  revision: number;
  folderId: string | null;
  /** ISO time it went to the trash, or null. */
  archivedAt: string | null;
  originalFileName: string | null;
  /** Pages that link here (not in the trash). */
  backlinks: { id: string; title: string }[];
}

export const MAX_PAGE_DOCS = 25;

export async function getPageDocs(
  campaignId: string,
  ids: readonly string[],
): Promise<PageDoc[]> {
  const wanted = [...new Set(ids)].slice(0, MAX_PAGE_DOCS);
  if (wanted.length === 0) return [];
  const [pages, links] = await Promise.all([
    prisma.page.findMany({
      where: { campaignId, id: { in: wanted } },
      select: {
        id: true,
        title: true,
        icon: true,
        content: true,
        revision: true,
        folderId: true,
        archivedAt: true,
        originalFileName: true,
      },
    }),
    prisma.pageLink.findMany({
      where: {
        campaignId,
        toPageId: { in: wanted },
        from: { archivedAt: null },
      },
      select: { toPageId: true, from: { select: { id: true, title: true } } },
      orderBy: { from: { title: "asc" } },
    }),
  ]);
  const backlinks = new Map<string, { id: string; title: string }[]>();
  for (const l of links)
    backlinks.set(l.toPageId, [...(backlinks.get(l.toPageId) ?? []), l.from]);
  return pages.map((p) => ({
    ...p,
    content: p.content as unknown as PmNode,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    backlinks: backlinks.get(p.id) ?? [],
  }));
}
