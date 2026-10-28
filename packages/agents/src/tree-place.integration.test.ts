import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@hearth/db";
import {
  createFolder,
  createPage,
  getWorkspaceTree,
  placeFolder,
  placePage,
} from "./workspace.js";
import { getQueue } from "./queue.js";

// Throwaway database only — see workspace.integration.test.ts.
const live = process.env.HEARTH_DB_TESTS === "1";

const C = "tp_test_campaign";
const OTHER = "tp_test_other";

describe.skipIf(!live)("arranging the tree (database)", () => {
  beforeAll(async () => {
    for (const id of [C, OTHER]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
  });
  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: [C, OTHER] } } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  const order = async (folderId: string | null) =>
    (await getWorkspaceTree(C)).pages
      .filter((p) => p.folderId === folderId)
      .map((p) => p.title);

  it("reorders pages and moves one into a folder, without touching 'last edited'", async () => {
    const npcs = await createFolder(C, null, "NPCs");
    const [a, b, c] = [
      await createPage(C, null, "A"),
      await createPage(C, null, "B"),
      await createPage(C, null, "C"),
    ];
    const before = await prisma.page.findUniqueOrThrow({ where: { id: c } });

    await placePage(C, c, null, a); // C before A
    expect(await order(null)).toEqual(["C", "A", "B"]);
    await placePage(C, c, null, null); // C last
    expect(await order(null)).toEqual(["A", "B", "C"]);

    await placePage(C, b, npcs, null);
    expect(await order(null)).toEqual(["A", "C"]);
    expect(await order(npcs)).toEqual(["B"]);

    const after = await prisma.page.findUniqueOrThrow({ where: { id: c } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("reorders and nests folders, never inside themselves", async () => {
    const places = await createFolder(C, null, "Places");
    const towns = await createFolder(C, places, "Towns");
    const lore = await createFolder(C, null, "Lore");

    await placeFolder(C, lore, null, places); // Lore before Places
    const top = (await getWorkspaceTree(C)).folders
      .filter((f) => f.parentId === null)
      .map((f) => f.name);
    expect(top.indexOf("Lore")).toBeLessThan(top.indexOf("Places"));

    await expect(placeFolder(C, places, towns, null)).rejects.toThrow(
      /inside itself/,
    );
    await placeFolder(C, lore, towns, null);
    const tree = (await getWorkspaceTree(C)).folders;
    expect(tree.find((f) => f.id === lore)?.parentId).toBe(towns);
  });

  it("refuses another campaign's folder or page", async () => {
    const theirs = await createFolder(OTHER, null, "Theirs");
    const mine = await createPage(C, null, "Mine");
    await expect(placePage(C, mine, theirs, null)).rejects.toThrow(
      /doesn't exist/,
    );
    const theirPage = await createPage(OTHER, null, "Theirs");
    await expect(placePage(C, theirPage, null, null)).rejects.toThrow(
      /doesn't exist/,
    );
  });
});
