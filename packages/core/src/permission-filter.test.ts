import { describe, it, expect } from "vitest";
import {
  filterKnowledge,
  type Viewer,
  type FilterableKnowledgeUnit,
} from "./permission-filter.js";

// These tests describe the guarantees the filter MUST provide. They are the
// most important tests in the repo. Written as `.todo` until the schema and the
// implementation land in Phase 0 — then they become the green gate before any
// UI or bot answers are trusted.

const dm: Viewer = { campaignId: "c1", membershipId: "m-dm", role: "DM", partyId: null };
const alice: Viewer = { campaignId: "c1", membershipId: "m-alice", role: "PLAYER", partyId: "p-a" };

const dmSecret: FilterableKnowledgeUnit = {
  id: "k-secret",
  campaignId: "c1",
  source: "DM_ADDED",
  visibility: "DM_ONLY",
  grantedPartyIds: [],
  grantedMembershipIds: [],
};

describe("filterKnowledge (Phase 0 spine)", () => {
  it.todo("never returns DM_ONLY units to a PLAYER");
  it.todo("returns EVERYONE units to any campaign member");
  it.todo("returns a PARTY-granted unit only to members of that party");
  it.todo("returns a PLAYERS-granted unit only to the named members");
  it.todo("returns SESSION units to the table without an explicit grant");
  it.todo("never leaks knowledge across campaigns (campaignId mismatch)");
  it.todo("returns DM_ONLY + everything to the DM");

  it("is wired up (placeholder throws until implemented)", () => {
    expect(() => filterKnowledge(alice, [dmSecret])).toThrow(/not implemented/);
    expect(dm.role).toBe("DM");
  });
});
