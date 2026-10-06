import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import { runAssistantTool } from "./assistant.js";
import { createPage, savePage } from "./workspace.js";
import { markdownToPage } from "./markdown-to-page.js";
import { getQueue } from "./queue.js";

// Throwaway database only — see workspace.integration.test.ts. No model calls: this checks the
// tools Claude is given can only ever see the DM's own campaign, whatever ids the model sends.
const live = process.env.HEARTH_DB_TESTS === "1";

const MINE = "asst_test_mine";
const THEIRS = "asst_test_theirs";
const dm: Viewer = {
  campaignId: MINE,
  role: "DM",
  characterId: null,
  partyId: null,
};

describe.skipIf(!live)("assistant tools stay inside the campaign", () => {
  let myPage: string;
  let theirPage: string;

  beforeAll(async () => {
    for (const id of [MINE, THEIRS]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
    myPage = await createPage(MINE, null, "My NPCs");
    await savePage(MINE, myPage, {
      title: "My NPCs",
      content: markdownToPage("Vess leads the Shepherds."),
      baseRevision: 0,
    });
    theirPage = await createPage(THEIRS, null, "Their secrets");
    await savePage(THEIRS, theirPage, {
      title: "Their secrets",
      content: markdownToPage("The vizier is a dragon."),
      baseRevision: 0,
    });
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: [MINE, THEIRS] } } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  it("reads the DM's own page", async () => {
    const r = await runAssistantTool(dm, "t1", "read_page", {
      page_id: myPage,
    });
    expect(r.content).toContain("Vess leads the Shepherds.");
  });

  it("refuses a page from another campaign, even by its exact id", async () => {
    const r = await runAssistantTool(dm, "t2", "read_page", {
      page_id: theirPage,
    });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("dragon");
  });

  it("lists only the DM's own pages", async () => {
    const r = await runAssistantTool(dm, "t3", "list_pages", {});
    expect(r.content).toContain("My NPCs");
    expect(r.content).not.toContain("Their secrets");
  });

  it("only proposes — it never writes to a page", async () => {
    const r = await runAssistantTool(dm, "t4", "propose_edit", {
      placement: "end",
      markdown: "- Old Hob",
      summary: "An NPC",
    });
    expect(r.proposal?.doc.content?.[0]?.type).toBe("bulletList");
    const page = await prisma.page.findUniqueOrThrow({ where: { id: myPage } });
    expect(page.markdown).toBe("Vess leads the Shepherds.");
  });

  it("rejects malformed tool input instead of guessing", async () => {
    expect(
      (
        await runAssistantTool(dm, "t5", "propose_edit", {
          placement: "everywhere",
          markdown: "x",
          summary: "s",
        })
      ).isError,
    ).toBe(true);
    expect(
      (await runAssistantTool(dm, "t6", "search_campaign", {})).isError,
    ).toBe(true);
    expect(
      (await runAssistantTool(dm, "t7", "delete_everything", {})).isError,
    ).toBe(true);
  });
});
