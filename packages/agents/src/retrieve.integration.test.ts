import { describe, it, expect } from "vitest";
import type { Viewer } from "@hearth/core";
import { retrieveForViewer } from "./retrieve.js";

// Hits Voyage + the seeded Supabase DB. Runs locally; SKIPPED in CI (no keys),
// so it never blocks the required check. Deterministic: asserts which unit ids
// the retrieval returns, no LLM involved.
const live = !!process.env.VOYAGE_API_KEY && !!process.env.DATABASE_URL;

const CAMPAIGN = "seed-ondera";
const PARTY = "seed-party-shepherds";
const dm: Viewer = {
  campaignId: CAMPAIGN,
  role: "DM",
  characterId: null,
  partyId: null,
};
const morwyn: Viewer = {
  campaignId: CAMPAIGN,
  role: "PLAYER",
  characterId: "seed-char-morwyn",
  partyId: PARTY,
};
const ildin: Viewer = {
  campaignId: CAMPAIGN,
  role: "PLAYER",
  characterId: "seed-char-ildin",
  partyId: PARTY,
};

describe.skipIf(!live)(
  "retrieveForViewer — permission-correct on real data",
  () => {
    it("gives the Shadow-Seeker secret to the DM but not to a player", async () => {
      const q = "Is the Shadow Seeker still influencing Ildin?";
      const dmIds = (await retrieveForViewer(dm, q, 15)).map((u) => u.id);
      const playerIds = (await retrieveForViewer(ildin, q, 15)).map(
        (u) => u.id,
      );
      expect(dmIds).toContain("seed-ku-secret-shadow-influence");
      expect(playerIds).not.toContain("seed-ku-secret-shadow-influence");
    }, 30_000);

    it("reveals Arvid's secret to Morwyn (granted) but not to Ildin", async () => {
      const q = "Did Arvid secretly prepare anything before Ildin's trial?";
      const morwynIds = (await retrieveForViewer(morwyn, q, 15)).map(
        (u) => u.id,
      );
      const ildinIds = (await retrieveForViewer(ildin, q, 15)).map((u) => u.id);
      expect(morwynIds).toContain("seed-ku-secret-arvid-reincarnate");
      expect(ildinIds).not.toContain("seed-ku-secret-arvid-reincarnate");
    }, 30_000);
  },
);
