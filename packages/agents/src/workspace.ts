// The DM's workspace: folders, pages, and each page's history (docs/workspace.md).
//
// Every function takes the campaign and scopes every query by it — an id from the browser is
// never trusted to belong to the campaign the caller was authorized for. The web layer checks
// the caller is the DM; this layer makes sure the rows they name are that campaign's.
//
// A page is the source of truth for its text. The memory indexes it DM-only (as page:<id>) a few
// seconds after the DM stops typing, so search and Claude see what's written without every
// keystroke re-embedding the page.

import { prisma, type Prisma } from "@hearth/db";
import { pageToMarkdown, EMPTY_PAGE, type PmNode } from "./page-markdown.js";
import { removeExternalDocument, syncExternalDocument } from "./external.js";
import { syncPageHighlights } from "./highlights.js";
import { getQueue } from "./queue.js";
import { PAGE_INDEX_QUEUE, type PageIndexJob } from "./jobs.js";

/** Edits within this long of the last version fold into it, so history reads as sittings. */
const VERSION_WINDOW_MS = 10 * 60_000;
/** How long after the last save a page is (re)indexed. */
const INDEX_DELAY_SEC = 20;
const NAME_MAX = 200;

/** A request the DM can fix; the message is safe to show them. */
export class WorkspaceError extends Error {}

const cleanName = (name: string, fallback: string) =>
  name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX) || fallback;

// ─── Tree ────────────────────────────────────────────────────────────────────

export interface TreeFolder {
  id: string;
  parentId: string | null;
  name: string;
}
export interface TreePage {
  id: string;
  folderId: string | null;
  title: string;
  updatedAt: Date;
}

/** Everything in the sidebar: every folder and every page not in the trash. */
export async function getWorkspaceTree(
  campaignId: string,
): Promise<{ folders: TreeFolder[]; pages: TreePage[] }> {
  const [folders, pages] = await Promise.all([
    prisma.folder.findMany({
      where: { campaignId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, parentId: true, name: true },
    }),
    prisma.page.findMany({
      where: { campaignId, archivedAt: null },
      orderBy: [{ position: "asc" }, { title: "asc" }],
      select: { id: true, folderId: true, title: true, updatedAt: true },
    }),
  ]);
  return { folders, pages };
}

async function ownFolder(campaignId: string, folderId: string | null) {
  if (folderId === null) return null;
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, campaignId },
    select: { id: true, parentId: true },
  });
  if (!folder) throw new WorkspaceError("That folder doesn't exist any more.");
  return folder;
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export async function createFolder(
  campaignId: string,
  parentId: string | null,
  name: string,
): Promise<string> {
  await ownFolder(campaignId, parentId);
  const folder = await prisma.folder.create({
    data: { campaignId, parentId, name: cleanName(name, "New folder") },
    select: { id: true },
  });
  return folder.id;
}

export async function renameFolder(
  campaignId: string,
  folderId: string,
  name: string,
): Promise<void> {
  await ownFolder(campaignId, folderId);
  await prisma.folder.update({
    where: { id: folderId },
    data: { name: cleanName(name, "Untitled folder") },
  });
}

/** Move a folder under another (or to the top level). Refuses to put a folder inside itself. */
export async function moveFolder(
  campaignId: string,
  folderId: string,
  newParentId: string | null,
): Promise<void> {
  await ownFolder(campaignId, folderId);
  // Walk up from the destination: meeting the folder being moved means it would contain itself.
  let cursor = await ownFolder(campaignId, newParentId);
  while (cursor) {
    if (cursor.id === folderId) {
      throw new WorkspaceError("A folder can't go inside itself.");
    }
    cursor = await ownFolder(campaignId, cursor.parentId);
  }
  await prisma.folder.update({
    where: { id: folderId },
    data: { parentId: newParentId },
  });
}

/** Delete an empty folder. One that still holds folders or pages is refused, never emptied. */
export async function deleteFolder(
  campaignId: string,
  folderId: string,
): Promise<void> {
  await ownFolder(campaignId, folderId);
  const [children, pages] = await Promise.all([
    prisma.folder.count({ where: { campaignId, parentId: folderId } }),
    prisma.page.count({ where: { campaignId, folderId, archivedAt: null } }),
  ]);
  if (children > 0 || pages > 0) {
    throw new WorkspaceError("Move or delete what's inside this folder first.");
  }
  // Pages already in the trash keep their place in the tree by landing at the top level.
  await prisma.$transaction([
    prisma.page.updateMany({
      where: { campaignId, folderId },
      data: { folderId: null },
    }),
    prisma.folder.delete({ where: { id: folderId } }),
  ]);
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export async function createPage(
  campaignId: string,
  folderId: string | null,
  title = "",
): Promise<string> {
  await ownFolder(campaignId, folderId);
  const page = await prisma.page.create({
    data: {
      campaignId,
      folderId,
      title: title.trim().slice(0, NAME_MAX),
      content: EMPTY_PAGE as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return page.id;
}

export interface PageView {
  id: string;
  folderId: string | null;
  title: string;
  content: PmNode;
  revision: number;
  archivedAt: Date | null;
  updatedAt: Date;
  /** The original file, for a page imported from Word or PDF. */
  originalFileName: string | null;
}

export async function getPage(
  campaignId: string,
  pageId: string,
): Promise<PageView | null> {
  const page = await prisma.page.findFirst({
    where: { id: pageId, campaignId },
    select: {
      id: true,
      folderId: true,
      title: true,
      content: true,
      revision: true,
      archivedAt: true,
      updatedAt: true,
      originalFileName: true,
    },
  });
  return page ? { ...page, content: page.content as unknown as PmNode } : null;
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; revision: number };

/**
 * Save a page from the editor. `baseRevision` is the revision the editor loaded; if the page has
 * moved on since (another tab, Claude, a session update), the save is refused and the editor is
 * told, rather than one silently overwriting the other.
 */
export async function savePage(
  campaignId: string,
  pageId: string,
  input: { title: string; content: PmNode; baseRevision: number },
): Promise<SaveResult> {
  if (input.content?.type !== "doc")
    throw new WorkspaceError("That isn't a page.");
  const title = input.title.trim().slice(0, NAME_MAX);
  const markdown = pageToMarkdown(input.content);
  const content = input.content as unknown as Prisma.InputJsonValue;

  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.page.updateMany({
      where: { id: pageId, campaignId, revision: input.baseRevision },
      data: { title, content, markdown, revision: { increment: 1 } },
    });
    if (count === 0) {
      const current = await tx.page.findFirst({
        where: { id: pageId, campaignId },
        select: { revision: true },
      });
      if (!current)
        throw new WorkspaceError("That page doesn't exist any more.");
      return {
        ok: false as const,
        conflict: true as const,
        revision: current.revision,
      };
    }
    await recordVersion(tx, pageId, { title, content, markdown }, "DM");
    return { ok: true as const, revision: input.baseRevision + 1 };
  });

  // The save has landed. Indexing is a follow-up: if queueing it fails, the page is still saved
  // (the next save queues it again) — never report a stored page as unsaved.
  if (result.ok) await schedulePageIndexQuietly(pageId);
  return result;
}

/** Add to the page's history: fold into the latest version if it's the DM's and recent. */
async function recordVersion(
  tx: Prisma.TransactionClient,
  pageId: string,
  snapshot: { title: string; content: Prisma.InputJsonValue; markdown: string },
  cause: "DM" | "RESTORE",
): Promise<void> {
  const latest = await tx.pageVersion.findFirst({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    select: { id: true, cause: true, createdAt: true },
  });
  if (
    cause === "DM" &&
    latest?.cause === "DM" &&
    Date.now() - latest.createdAt.getTime() < VERSION_WINDOW_MS
  ) {
    await tx.pageVersion.update({ where: { id: latest.id }, data: snapshot });
    return;
  }
  await tx.pageVersion.create({ data: { pageId, cause, ...snapshot } });
}

export async function movePage(
  campaignId: string,
  pageId: string,
  folderId: string | null,
): Promise<void> {
  await ownFolder(campaignId, folderId);
  const { count } = await prisma.page.updateMany({
    where: { id: pageId, campaignId },
    data: { folderId },
  });
  if (count === 0)
    throw new WorkspaceError("That page doesn't exist any more.");
  // Its name in search carries the folder path.
  await schedulePageIndexQuietly(pageId);
}

/** Put a page in the trash: out of the tree and out of the memory, but restorable. */
export async function archivePage(
  campaignId: string,
  pageId: string,
): Promise<void> {
  const { count } = await prisma.page.updateMany({
    where: { id: pageId, campaignId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (count > 0) await schedulePageIndexQuietly(pageId, 0);
}

export async function restorePage(
  campaignId: string,
  pageId: string,
): Promise<void> {
  const page = await prisma.page.findFirst({
    where: { id: pageId, campaignId },
    select: { folderId: true },
  });
  if (!page) throw new WorkspaceError("That page doesn't exist any more.");
  // Its folder may have been deleted while it sat in the trash.
  const folderStillThere =
    page.folderId &&
    (await prisma.folder.count({ where: { id: page.folderId, campaignId } })) >
      0;
  await prisma.page.update({
    where: { id: pageId },
    data: { archivedAt: null, ...(folderStillThere ? {} : { folderId: null }) },
  });
  await schedulePageIndexQuietly(pageId, 0);
}

export function listTrash(campaignId: string) {
  return prisma.page.findMany({
    where: { campaignId, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    select: { id: true, title: true, archivedAt: true },
  });
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function listPageVersions(campaignId: string, pageId: string) {
  return prisma.pageVersion.findMany({
    where: { pageId, page: { campaignId } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      cause: true,
      createdAt: true,
      updatedAt: true,
      markdown: true,
    },
  });
}

/** Make an old version the page's current text. The current text stays in history. */
export async function restorePageVersion(
  campaignId: string,
  pageId: string,
  versionId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const version = await tx.pageVersion.findFirst({
      where: { id: versionId, pageId, page: { campaignId } },
      select: { title: true, content: true, markdown: true },
    });
    if (!version) throw new WorkspaceError("That version doesn't exist.");
    const snapshot = {
      title: version.title,
      content: version.content as Prisma.InputJsonValue,
      markdown: version.markdown,
    };
    await tx.page.update({
      where: { id: pageId },
      data: { ...snapshot, revision: { increment: 1 } },
    });
    await recordVersion(tx, pageId, snapshot, "RESTORE");
  });
  await schedulePageIndexQuietly(pageId, 0);
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/** schedulePageIndex for paths where the user's change has already been stored. */
async function schedulePageIndexQuietly(
  pageId: string,
  delaySec?: number,
): Promise<void> {
  try {
    await schedulePageIndex(pageId, delaySec);
  } catch (err) {
    console.error(
      `queueing index for page ${pageId} failed (the page itself is saved):`,
      err,
    );
  }
}

export async function schedulePageIndex(
  pageId: string,
  delaySec = INDEX_DELAY_SEC,
): Promise<void> {
  const job: PageIndexJob = { pageId };
  // One waiting job per page: further saves inside the delay ride on it, and it reads the page
  // as it is when it runs.
  await (
    await getQueue()
  ).send(PAGE_INDEX_QUEUE, job, {
    singletonKey: pageId,
    startAfter: delaySec,
  });
}

/** Where a page sits, for its name in search: "World / Factions / The Shepherds". */
async function pagePath(
  campaignId: string,
  folderId: string | null,
): Promise<string[]> {
  const path: string[] = [];
  let id = folderId;
  for (let depth = 0; id && depth < 50; depth++) {
    const folder = await prisma.folder.findFirst({
      where: { id, campaignId },
      select: { name: true, parentId: true },
    });
    if (!folder) break;
    path.unshift(folder.name);
    id = folder.parentId;
  }
  return path;
}

/** Bring the memory's copy of a page in line with the page. Runs in the worker. */
export async function indexPage(pageId: string): Promise<void> {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      campaignId: true,
      folderId: true,
      title: true,
      markdown: true,
      archivedAt: true,
    },
  });
  const externalId = `page:${pageId}`;
  if (!page) return;
  // Highlights first: what players may know shouldn't wait on re-embedding the whole page.
  await syncPageHighlights(pageId);
  if (page.archivedAt) {
    await removeExternalDocument(page.campaignId, externalId);
    return;
  }
  const name = [
    ...(await pagePath(page.campaignId, page.folderId)),
    page.title || "Untitled",
  ].join(" / ");
  await syncExternalDocument({
    campaignId: page.campaignId,
    externalId,
    sourceType: "PAGE",
    name,
    text: page.markdown,
    fileStem: `page-${pageId}`,
    // The DM's own writing. What players learn from it comes through highlights
    // (highlights.ts), never from the page as a whole.
    baseVisibility: "DM_ONLY",
    // Search and Claude read the page itself; facts come from what the DM marks as canon,
    // not from a model guessing at a draft on every save.
    extractUnits: false,
  });
}
