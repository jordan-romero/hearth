import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@hearth/db";
import { sealSecret } from "./secrets.js";
import { runOneNoteImport, startOneNoteImport } from "./onenote.js";
import { getQueue } from "./queue.js";

// Throwaway database only — see workspace.integration.test.ts. Microsoft is faked: fetch is
// replaced with a tiny in-memory Graph, so no account or network is needed.
const live = process.env.HEARTH_DB_TESTS === "1";

const C = "on_test_campaign";

// A notebook "Ondera" with a section at the top and one inside a nested section group.
const graph = {
  sectionGroups: [
    {
      id: "g1",
      displayName: "World",
      parentNotebook: { displayName: "Ondera" },
    },
    { id: "g2", displayName: "Factions", parentSectionGroup: { id: "g1" } },
  ],
  sections: [
    {
      id: "s1",
      displayName: "Sessions",
      parentNotebook: { displayName: "Ondera" },
    },
    { id: "s2", displayName: "Shepherds", parentSectionGroup: { id: "g2" } },
  ],
  pages: {
    s1: [
      { id: "p2", title: "Session 2", order: 1 },
      { id: "p1", title: "Session 1", order: 0 },
    ],
    s2: [{ id: "p3", title: "Vess", order: 0 }],
  } as Record<string, { id: string; title: string; order: number }[]>,
  content: {
    p1: "<html><head><title>Session 1</title></head><body><h1>Arrival</h1><p>They reach the <b>Old Mill</b>.</p></body></html>",
    p2: "<html><body><p>The ford floods.</p></body></html>",
    p3: "<html><body><ul><li>Leader</li><li>Exiled</li></ul></body></html>",
  } as Record<string, string>,
  tokenError: null as string | null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("/oauth2/v2.0/token")) {
    return Promise.resolve(
      graph.tokenError
        ? json({ error: graph.tokenError }, 400)
        : json({ access_token: "at", refresh_token: "rt-rotated" }),
    );
  }
  const path = url.replace("https://graph.microsoft.com/v1.0", "");
  if (path.startsWith("/me/onenote/sectionGroups"))
    return Promise.resolve(json({ value: graph.sectionGroups }));
  if (path.startsWith("/me/onenote/sections/")) {
    const id = decodeURIComponent(path.split("/")[4]!);
    return Promise.resolve(json({ value: graph.pages[id] ?? [] }));
  }
  if (path.startsWith("/me/onenote/sections"))
    return Promise.resolve(json({ value: graph.sections }));
  if (path.startsWith("/me/onenote/pages/")) {
    const id = decodeURIComponent(path.split("/")[4]!);
    return Promise.resolve(
      new Response(graph.content[id] ?? "", { status: 200 }),
    );
  }
  return Promise.resolve(new Response("not faked: " + path, { status: 404 }));
}

describe.skipIf(!live)("OneNote import (database, faked Microsoft)", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    process.env.HEARTH_ENCRYPTION_KEY =
      "test-encryption-key-at-least-32-characters-long";
    globalThis.fetch = vi.fn(fakeFetch) as typeof fetch;
    await prisma.campaign.upsert({
      where: { id: C },
      create: { id: C, name: C },
      update: {},
    });
    await prisma.oneNoteConnection.create({
      data: {
        campaignId: C,
        connectedByMembershipId: "m",
        accountName: "dm@outlook.com",
        refreshTokenEnc: sealSecret("rt-original", "onenote-refresh-token"),
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await prisma.campaign.deleteMany({ where: { id: C } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  async function importAll() {
    const batchId = await startOneNoteImport(C, {
      sectionIds: ["s1", "s2"],
      destinationFolderId: null,
      label: "Ondera",
    });
    await runOneNoteImport({ batchId, sectionIds: ["s1", "s2"] });
    return prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  }

  it("brings notebooks, groups and sections in as folders, pages in OneNote's order", async () => {
    const batch = await importAll();
    expect(batch).toMatchObject({
      status: "DONE",
      pagesCreated: 3,
      filesSkipped: 0,
      message: null,
    });

    const folders = await prisma.folder.findMany({ where: { campaignId: C } });
    const pathOf = (id: string | null): string => {
      const f = folders.find((x) => x.id === id);
      return f ? [pathOf(f.parentId), f.name].filter(Boolean).join(" / ") : "";
    };
    const pages = await prisma.page.findMany({
      where: { campaignId: C },
      orderBy: [{ folderId: "asc" }, { position: "asc" }],
    });
    expect(
      pages.map((p) => `${pathOf(p.folderId)} :: ${p.title}`).sort(),
    ).toEqual([
      "Ondera / Sessions :: Session 1",
      "Ondera / Sessions :: Session 2",
      "Ondera / World / Factions / Shepherds :: Vess",
    ]);
    const s1 = pages.filter((p) => p.title.startsWith("Session"));
    expect(s1.find((p) => p.title === "Session 1")!.position).toBeLessThan(
      s1.find((p) => p.title === "Session 2")!.position,
    );

    // Body headings sit below the page title; the <title> isn't repeated in the body.
    expect(pages.find((p) => p.title === "Session 1")!.markdown).toBe(
      "## Arrival\n\nThey reach the **Old Mill**.",
    );
    expect(pages.find((p) => p.title === "Vess")!.markdown).toBe(
      "- Leader\n- Exiled",
    );

    // Microsoft rotated the refresh token; the new one is what's stored (sealed, not plain).
    const conn = await prisma.oneNoteConnection.findUniqueOrThrow({
      where: { campaignId: C },
    });
    expect(conn.refreshTokenEnc).not.toContain("rt-");
  });

  it("running it again only brings in new pages", async () => {
    graph.pages.s1!.push({ id: "p4", title: "Session 3", order: 2 });
    graph.content.p4 = "<p>New.</p>";
    const batch = await importAll();
    expect(batch).toMatchObject({ pagesCreated: 1, filesSkipped: 3 });
  });

  it("says so when the Microsoft sign-in has expired", async () => {
    graph.tokenError = "invalid_grant";
    const batch = await importAll();
    expect(batch.status).toBe("DONE");
    expect(batch.message).toMatch(/sign-in expired/);
    graph.tokenError = null;
  });
});
