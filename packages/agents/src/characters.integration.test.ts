import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@hearth/db";
import { addCharacter, getTableColors } from "./highlights.js";
import { joinCampaign } from "./onboarding.js";

// Throwaway database only — see workspace.integration.test.ts.
const live = process.env.HEARTH_DB_TESTS === "1";

const C = "char_test_campaign";
const PLAYER = "char_test_discord_patrick";

describe.skipIf(!live)("DM-added characters (database)", () => {
  beforeAll(async () => {
    await prisma.campaign.upsert({
      where: { id: C },
      create: { id: C, name: C },
      update: {},
    });
  });
  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: C } });
    await prisma.user.deleteMany({ where: { discordUserId: PLAYER } });
    await prisma.$disconnect();
  });

  it("adds a character with no player, shown with the others", async () => {
    const added = await addCharacter(C, {
      name: "  Dalakhi ",
      color: "#3d9a6b",
    });
    expect(added.ok).toBe(true);
    const colors = await getTableColors(C);
    expect(colors.characters).toEqual([
      expect.objectContaining({ name: "Dalakhi", color: "#3d9a6b" }),
    ]);
  });

  it("refuses a blank name or one the campaign already has", async () => {
    expect(await addCharacter(C, { name: "   " })).toMatchObject({
      ok: false,
    });
    expect(await addCharacter(C, { name: "dalakhi" })).toEqual({
      ok: false,
      error: "There's already a dalakhi.",
    });
  });

  it("the player's /join with the same name claims it instead of making another", async () => {
    const before = await prisma.character.findFirstOrThrow({
      where: { campaignId: C, name: "Dalakhi" },
    });
    const joined = await joinCampaign(C, PLAYER, "Patrick", "DALAKHI", {
      className: "Bard",
    });
    expect(joined).toEqual({
      kind: "joined",
      characterId: before.id,
      characterName: "Dalakhi",
      renamed: false,
    });
    const after = await prisma.character.findMany({ where: { campaignId: C } });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      color: "#3d9a6b",
      class: "Bard",
    });
    expect(after[0]!.membershipId).not.toBeNull();
  });
});
