import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@hearth/db";
import { filterKnowledge, type Viewer } from "@hearth/core";
import { syncPageHighlights } from "./highlights.js";
import { createPage, savePage } from "./workspace.js";
import { getQueue } from "./queue.js";
import type { PmNode } from "./page-markdown.js";

// No network: embeddings are stubbed.
vi.mock("./embeddings.js", () => ({
  embedTexts: async (texts: string[]) => texts.map(() => null),
  toVectorLiteral: () => "[]",
}));

// Throwaway database only — see workspace.integration.test.ts.
const live = process.env.HEARTH_DB_TESTS === "1";

const C = "hl_test_campaign";
const OTHER = "hl_test_other";

type Mark = { id: string; known?: string[]; everyone?: boolean };
const page = (...parts: (string | [string, Mark])[]): PmNode => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: parts.map((part) =>
        typeof part === "string"
          ? { type: "text", text: part }
          : {
              type: "text",
              text: part[0],
              marks: [
                {
                  type: "canon",
                  attrs: { known: [], everyone: false, ...part[1] },
                },
              ],
            },
      ),
    },
  ],
});

describe.skipIf(!live)("page highlights → knowledge (database)", () => {
  let pageId: string;
  let revision = 0;
  let arvid: string;
  let morwun: string;
  let stranger: string;

  const asPlayer = (characterId: string): Viewer => ({
    campaignId: C,
    role: "PLAYER",
    characterId,
    partyId: null,
  });

  /** Save the page and run the sync, as the worker would. */
  async function write(doc: PmNode) {
    const r = await savePage(C, pageId, {
      title: "Shepherds",
      content: doc,
      baseRevision: revision,
    });
    if (!r.ok) throw new Error("save conflict");
    revision = r.revision;
    return syncPageHighlights(pageId);
  }

  async function visibleTo(characterId: string) {
    const units = await prisma.knowledgeUnit.findMany({
      where: { campaignId: C },
      select: {
        id: true,
        campaignId: true,
        baseVisibility: true,
        canon: true,
        content: true,
        grants: { select: { characterId: true, partyId: true } },
      },
    });
    return filterKnowledge(
      asPlayer(characterId),
      units.map((u) => ({
        ...u,
        grantedCharacterIds: u.grants.flatMap((g) =>
          g.characterId ? [g.characterId] : [],
        ),
        grantedPartyIds: u.grants.flatMap((g) =>
          g.partyId ? [g.partyId] : [],
        ),
      })),
    ).map((u) => u.content);
  }

  beforeAll(async () => {
    for (const id of [C, OTHER]) {
      await prisma.campaign.upsert({
        where: { id },
        create: { id, name: id },
        update: {},
      });
    }
    const user = await prisma.user.upsert({
      where: { email: "hl-dm@test.local" },
      create: { email: "hl-dm@test.local" },
      update: {},
    });
    const dm = await prisma.membership.create({
      data: { userId: user.id, campaignId: C, role: "DM" },
    });
    const mk = (name: string, campaignId: string) =>
      prisma.character
        .create({ data: { campaignId, name, membershipId: dm.id } })
        .then((c) => c.id);
    arvid = await mk("Arvid", C);
    morwun = await mk("Morwun", C);
    stranger = await mk("Someone else", OTHER);
    pageId = await createPage(C, null, "Shepherds");
  });

  afterAll(async () => {
    // Reveal records point at the DM's membership; clear them before the campaign goes.
    await prisma.revealEvent.deleteMany({
      where: { by: { campaignId: { in: [C, OTHER] } } },
    });
    await prisma.knowledgeGrant.deleteMany({
      where: { revealedBy: { campaignId: { in: [C, OTHER] } } },
    });
    await prisma.campaign.deleteMany({ where: { id: { in: [C, OTHER] } } });
    await prisma.user.deleteMany({ where: { email: "hl-dm@test.local" } });
    await (await getQueue()).stop({ graceful: false });
    await prisma.$disconnect();
  });

  it("working text and unknown canon reach no player", async () => {
    await write(
      page("Maybe Vess has a twin. ", [
        "Vess is the Emperor's half-sister.",
        { id: "h-secret" },
      ]),
    );
    expect(await visibleTo(arvid)).toEqual([]);
    const unit = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-secret" },
    });
    expect(unit).toMatchObject({
      baseVisibility: "DM_ONLY",
      canon: "CANON",
      sourcePageId: pageId,
    });
  });

  it("a highlight known by one character reaches only them, as a logged reveal", async () => {
    await write(
      page(["Vess is the Emperor's half-sister.", { id: "h-secret" }], " ", [
        "Vess meets pilgrims at the Old Mill.",
        { id: "h-mill", known: [arvid] },
      ]),
    );
    expect(await visibleTo(arvid)).toEqual([
      "Vess meets pilgrims at the Old Mill.",
    ]);
    expect(await visibleTo(morwun)).toEqual([]);
    const unit = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-mill" },
    });
    const events = await prisma.revealEvent.findMany({
      where: { knowledgeUnitId: unit!.id },
    });
    expect(events.map((e) => [e.action, e.characterId])).toEqual([
      ["REVEAL", arvid],
    ]);
  });

  it("ignores a character from another campaign", async () => {
    await write(
      page(
        [
          "Vess meets pilgrims at the Old Mill.",
          { id: "h-mill", known: [arvid] },
        ],
        " ",
        ["The stones hum.", { id: "h-stones", known: [stranger] }],
      ),
    );
    const unit = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-stones" },
      include: { grants: true },
    });
    expect(unit?.grants).toEqual([]);
  });

  it("rewording keeps the same knowledge and its reveal", async () => {
    // h-stones leaves the page now; it was never shown to anyone, so it goes.
    const before = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-mill" },
    });
    const result = await write(
      page([
        "Vess meets pilgrims only at the Old Mill, at dusk.",
        { id: "h-mill", known: [arvid] },
      ]),
    );
    expect(result).toMatchObject({ updated: 1, removed: 1, created: 0 });
    const after = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-mill" },
    });
    expect(after!.id).toBe(before!.id);
    expect(await visibleTo(arvid)).toEqual([
      "Vess meets pilgrims only at the Old Mill, at dusk.",
    ]);
  });

  it("adding and removing who knows reveals and revokes", async () => {
    await write(
      page([
        "Vess meets pilgrims only at the Old Mill, at dusk.",
        { id: "h-mill", known: [morwun] },
      ]),
    );
    expect(await visibleTo(arvid)).toEqual([]);
    expect(await visibleTo(morwun)).toHaveLength(1);
    const unit = await prisma.knowledgeUnit.findUnique({
      where: { highlightId: "h-mill" },
    });
    const actions = (
      await prisma.revealEvent.findMany({
        where: { knowledgeUnitId: unit!.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((e) => `${e.action}:${e.characterId === arvid ? "arvid" : "morwun"}`);
    expect(actions).toEqual(["REVEAL:arvid", "REVEAL:morwun", "REVOKE:arvid"]);
  });

  it("'the whole table' makes it everyone's", async () => {
    await write(
      page([
        "Vess meets pilgrims only at the Old Mill, at dusk.",
        { id: "h-mill", everyone: true },
      ]),
    );
    expect(await visibleTo(arvid)).toHaveLength(1);
    expect(await visibleTo(morwun)).toHaveLength(1);
  });

  it("deleting highlighted text keeps what players were already told", async () => {
    const result = await write(page("The page was rewritten."));
    expect(result).toMatchObject({ kept: 1, removed: 0 });
    const unit = await prisma.knowledgeUnit.findFirst({
      where: { campaignId: C, content: { contains: "Old Mill" } },
    });
    expect(unit).toMatchObject({ highlightId: "h-mill", sourcePageId: pageId });
    expect(await visibleTo(arvid)).toHaveLength(1);
  });

  it("bringing the text back (an undo) reuses the same knowledge, not a copy", async () => {
    const result = await write(
      page([
        "Vess meets pilgrims only at the Old Mill, at dusk.",
        { id: "h-mill", everyone: true },
      ]),
    );
    expect(result).toMatchObject({ created: 0 });
    expect(await visibleTo(arvid)).toHaveLength(1);
  });
});
