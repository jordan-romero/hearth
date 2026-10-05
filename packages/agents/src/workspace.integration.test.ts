import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@hearth/db";
import {
  createFolder,
  createPage,
  deleteFolder,
  getPage,
  moveFolder,
  movePage,
  renameFolder,
  restorePageVersion,
  savePage,
  WorkspaceError,
} from "./workspace.js";
import { EMPTY_PAGE } from "./page-markdown.js";
import { getQueue } from "./queue.js";

// Writes real rows, so it only runs against a throwaway database you opt into:
//   HEARTH_DB_TESTS=1 DATABASE_URL=… DIRECT_URL=… pnpm vitest run src/workspace.integration.test.ts
// Never point it at the shared Supabase database.
const live = process.env.HEARTH_DB_TESTS === "1";

const A = "ws_test_campaign_a";
const B = "ws_test_campaign_b";
const para = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe.skipIf(!live)("workspace (database)", () => {
  beforeAll(async () => {
    for (const id of [A, B]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: [A, B] } } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  it("refuses another campaign's folder and page ids", async () => {
    const theirs = await createFolder(B, null, "Theirs");
    const theirPage = await createPage(B, null, "Their secret");

    await expect(createPage(A, theirs)).rejects.toBeInstanceOf(WorkspaceError);
    await expect(createFolder(A, theirs, "Sneaky")).rejects.toBeInstanceOf(
      WorkspaceError,
    );
    await expect(renameFolder(A, theirs, "Mine now")).rejects.toBeInstanceOf(
      WorkspaceError,
    );
    await expect(movePage(A, theirPage, null)).rejects.toBeInstanceOf(
      WorkspaceError,
    );
    expect(await getPage(A, theirPage)).toBeNull();
    await expect(
      savePage(A, theirPage, {
        title: "x",
        content: EMPTY_PAGE,
        baseRevision: 0,
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);

    // Untouched.
    expect((await getPage(B, theirPage))?.title).toBe("Their secret");
  });

  it("won't put a folder inside itself or its own subfolder", async () => {
    const top = await createFolder(A, null, "Top");
    const child = await createFolder(A, top, "Child");
    await expect(moveFolder(A, top, top)).rejects.toThrow(/inside itself/);
    await expect(moveFolder(A, top, child)).rejects.toThrow(/inside itself/);
    await moveFolder(A, child, null); // moving up is fine
  });

  it("won't delete a folder that still holds pages", async () => {
    const folder = await createFolder(A, null, "Full");
    await createPage(A, folder, "Keep me");
    await expect(deleteFolder(A, folder)).rejects.toThrow(/inside/);
  });

  it("refuses a save made from an out-of-date copy", async () => {
    const page = await createPage(A, null, "Speech");
    const first = await savePage(A, page, {
      title: "Speech",
      content: para("v1"),
      baseRevision: 0,
    });
    expect(first).toEqual({ ok: true, revision: 1 });

    // Another tab still thinks it's at revision 0.
    const stale = await savePage(A, page, {
      title: "Speech",
      content: para("other"),
      baseRevision: 0,
    });
    expect(stale).toEqual({ ok: false, conflict: true, revision: 1 });
    expect(
      (await prisma.page.findUnique({ where: { id: page } }))?.markdown,
    ).toBe("v1");
  });

  it("restores an old version and keeps the current one in history", async () => {
    const page = await createPage(A, null, "Lore");
    await savePage(A, page, {
      title: "Lore",
      content: para("old"),
      baseRevision: 0,
    });
    // Force the next save into its own version rather than folding into the first.
    await prisma.pageVersion.updateMany({
      where: { pageId: page },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });
    await savePage(A, page, {
      title: "Lore",
      content: para("new"),
      baseRevision: 1,
    });

    const versions = await prisma.pageVersion.findMany({
      where: { pageId: page },
      orderBy: { createdAt: "asc" },
    });
    expect(versions.map((v) => v.markdown)).toEqual(["old", "new"]);

    await restorePageVersion(A, page, versions[0]!.id);
    const after = await prisma.page.findUnique({ where: { id: page } });
    expect(after?.markdown).toBe("old");
    expect(after?.revision).toBe(3);
    const history = await prisma.pageVersion.findMany({
      where: { pageId: page },
    });
    expect(history.map((v) => v.markdown).sort()).toEqual([
      "new",
      "old",
      "old",
    ]);

    // A version id from another page can't be restored onto this one.
    const other = await createPage(B, null, "B page");
    await savePage(B, other, {
      title: "B",
      content: para("b"),
      baseRevision: 0,
    });
    const bVersion = await prisma.pageVersion.findFirst({
      where: { pageId: other },
    });
    await expect(
      restorePageVersion(A, page, bVersion!.id),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});
