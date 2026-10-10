import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@hearth/db";
import {
  createPage,
  getBacklinks,
  getPage,
  relinkPages,
  savePage,
  archivePage,
} from "./workspace.js";
import { markdownToPage } from "./markdown-to-page.js";
import { getQueue } from "./queue.js";
import type { PmNode } from "./page-markdown.js";

// Throwaway database only — see workspace.integration.test.ts.
const live = process.env.HEARTH_DB_TESTS === "1";

const C = "pl_test_campaign";
const OTHER = "pl_test_other";

/** Every page link in a page: [pageId, label]. */
function links(doc: PmNode): [string | null, string][] {
  const out: [string | null, string][] = [];
  const walk = (n: PmNode) => {
    if (n.type === "pageLink")
      out.push([
        (n.attrs?.pageId as string | null) ?? null,
        String(n.attrs?.label),
      ]);
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

async function write(pageId: string, markdown: string, title?: string) {
  const page = (await getPage(C, pageId))!;
  const result = await savePage(C, pageId, {
    title: title ?? page.title,
    content: markdownToPage(markdown),
    baseRevision: page.revision,
  });
  expect(result.ok).toBe(true);
  return (await getPage(C, pageId))!;
}

describe.skipIf(!live)("page links (database)", () => {
  let ildin: string;
  let vess: string;
  let theirs: string;

  beforeAll(async () => {
    for (const id of [C, OTHER]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
    ildin = await createPage(C, null, "Ildin");
    vess = await createPage(C, null, "Vess");
    theirs = await createPage(OTHER, null, "Mill");
  });
  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: [C, OTHER] } } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  it("a save resolves [[Title]] and records the link as a backlink", async () => {
    const page = await write(vess, "Owes [[ildin]] a debt, and [[Mill]] too.");
    expect(links(page.content)).toEqual([
      [ildin, "Ildin"],
      [null, "Mill"], // another campaign's page never resolves
    ]);
    expect(await getBacklinks(C, ildin)).toEqual([{ id: vess, title: "Vess" }]);
    expect(await getBacklinks(OTHER, theirs)).toEqual([]);
  });

  it("a save also links [[Title]] left as plain text", async () => {
    const page = await getPage(C, ildin);
    await savePage(C, ildin, {
      title: "Ildin",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Serves [[Vess]]." }],
          },
        ],
      },
      baseRevision: page!.revision,
    });
    expect(links((await getPage(C, ildin))!.content)).toEqual([[vess, "Vess"]]);
    expect(await getBacklinks(C, vess)).toEqual([
      { id: ildin, title: "Ildin" },
    ]);
    await write(ildin, "Plain again.");
  });

  it("making the page a link was waiting for resolves it", async () => {
    const mill = await createPage(C, null, "Mill");
    expect(links((await getPage(C, vess))!.content)).toEqual([
      [ildin, "Ildin"],
      [mill, "Mill"],
    ]);
    expect(await getBacklinks(C, mill)).toEqual([{ id: vess, title: "Vess" }]);
  });

  it("renaming a page relabels links to it, which still lead there", async () => {
    await write(ildin, "The old ferryman.", "Ildin the Ferryman");
    expect(links((await getPage(C, vess))!.content)[0]).toEqual([
      ildin,
      "Ildin the Ferryman",
    ]);
    expect(
      (await prisma.page.findUnique({ where: { id: vess } }))!.markdown,
    ).toContain("[[Ildin the Ferryman]]");
  });

  it("removing a link removes the backlink; a trashed page doesn't count", async () => {
    await write(vess, "No links any more.");
    expect(await getBacklinks(C, ildin)).toEqual([]);

    const notes = await createPage(C, null, "Notes");
    await write(notes, "About [[Ildin the Ferryman]].");
    expect(await getBacklinks(C, ildin)).toHaveLength(1);
    await archivePage(C, notes);
    expect(await getBacklinks(C, ildin)).toEqual([]);
  });

  it("relinking an imported page turns its literal [[text]] into links", async () => {
    const imported = await prisma.page.create({
      data: {
        campaignId: C,
        title: "Old notes",
        // As an old import left it: the brackets as plain text.
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Ask [[Vess]] first." }],
            },
          ],
        },
      },
    });
    expect(await relinkPages(C, [imported.id])).toBe(1);
    expect(links((await getPage(C, imported.id))!.content)).toEqual([
      [vess, "Vess"],
    ]);
    expect(await getBacklinks(C, vess)).toEqual([
      { id: imported.id, title: "Old notes" },
    ]);
    // Running it again changes nothing.
    expect(await relinkPages(C, [imported.id])).toBe(0);
  });
});
