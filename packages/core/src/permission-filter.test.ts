import { describe, it, expect } from "vitest";
import {
  canView,
  filterKnowledge,
  type Viewer,
  type FilterableKnowledgeUnit,
} from "./permission-filter.js";

// ─── The most important tests in the repo ────────────────────────────────────
// A leak here is a spoiler spoken aloud at the table, so these are written
// adversarially: for every "may see" there is a matching "must NOT see".

/** Build a unit tersely; sensible defaults, override what the case needs. */
function unit(
  over: Partial<FilterableKnowledgeUnit> &
    Pick<FilterableKnowledgeUnit, "id" | "baseVisibility">,
): FilterableKnowledgeUnit {
  return {
    campaignId: "c1",
    grantedCharacterIds: [],
    grantedPartyIds: [],
    ...over,
  };
}

// Viewers in campaign c1
const dm: Viewer = { campaignId: "c1", role: "DM", characterId: null, partyId: null };
const alice: Viewer = { campaignId: "c1", role: "PLAYER", characterId: "char-alice", partyId: "party-1" };
const bob: Viewer = { campaignId: "c1", role: "PLAYER", characterId: "char-bob", partyId: "party-2" };
// A DM of a DIFFERENT campaign
const dmOfC2: Viewer = { campaignId: "c2", role: "DM", characterId: null, partyId: null };

// Units
const sessionFact = unit({ id: "k-session", baseVisibility: "EVERYONE" }); // SESSION → stored EVERYONE
const dmSecret = unit({ id: "k-secret", baseVisibility: "DM_ONLY" });
const publicUnit = unit({ id: "k-public", baseVisibility: "PUBLIC" });
const revealedToAlice = unit({ id: "k-to-alice", baseVisibility: "DM_ONLY", grantedCharacterIds: ["char-alice"] });
const revealedToParty1 = unit({ id: "k-to-party1", baseVisibility: "DM_ONLY", grantedPartyIds: ["party-1"] });
const otherCampaignFact = unit({ id: "k-c2", baseVisibility: "EVERYONE", campaignId: "c2" });

describe("filterKnowledge — the permission spine", () => {
  it("never returns DM_ONLY knowledge to a player", () => {
    expect(canView(alice, dmSecret)).toBe(false);
    expect(filterKnowledge(alice, [dmSecret])).toEqual([]);
  });

  it("returns EVERYONE (session-derived) knowledge to any campaign member without a grant", () => {
    expect(canView(alice, sessionFact)).toBe(true);
    expect(canView(bob, sessionFact)).toBe(true);
  });

  it("returns PUBLIC knowledge to any campaign member", () => {
    expect(canView(alice, publicUnit)).toBe(true);
  });

  it("returns a character-granted unit ONLY to that character", () => {
    expect(canView(alice, revealedToAlice)).toBe(true); // grantee
    expect(canView(bob, revealedToAlice)).toBe(false); // not the grantee
  });

  it("returns a party-granted unit ONLY to members of that party", () => {
    expect(canView(alice, revealedToParty1)).toBe(true); // party-1
    expect(canView(bob, revealedToParty1)).toBe(false); // party-2
  });

  it("gives the DM everything in their campaign, DM_ONLY included", () => {
    const all = [sessionFact, dmSecret, revealedToAlice, revealedToParty1, publicUnit];
    expect(canView(dm, dmSecret)).toBe(true);
    expect(filterKnowledge(dm, all)).toHaveLength(all.length);
  });

  it("never leaks across campaigns — not to a player, not even to another campaign's DM", () => {
    expect(canView(alice, otherCampaignFact)).toBe(false); // wrong campaign
    expect(canView(dmOfC2, sessionFact)).toBe(false); // DM of c2 can't see c1
    expect(filterKnowledge(alice, [otherCampaignFact])).toEqual([]);
  });

  it("filters a mixed batch down to exactly what each viewer may know", () => {
    const batch = [
      sessionFact,
      dmSecret,
      revealedToAlice,
      revealedToParty1,
      publicUnit,
      otherCampaignFact,
    ];

    expect(filterKnowledge(alice, batch).map((u) => u.id)).toEqual([
      "k-session",
      "k-to-alice",
      "k-to-party1",
      "k-public",
    ]);

    // Bob: no grants that apply, different party, wrong campaign for c2 → only the open knowledge
    expect(filterKnowledge(bob, batch).map((u) => u.id)).toEqual([
      "k-session",
      "k-public",
    ]);
  });

  it("preserves input order and never invents units", () => {
    const batch = [publicUnit, dmSecret, sessionFact];
    const result = filterKnowledge(alice, batch);
    expect(result.map((u) => u.id)).toEqual(["k-public", "k-session"]);
    result.forEach((u) => expect(batch).toContain(u));
  });

  it("a character-less player (no characterId, no party) sees only open knowledge", () => {
    const spectator: Viewer = { campaignId: "c1", role: "PLAYER", characterId: null, partyId: null };
    expect(canView(spectator, sessionFact)).toBe(true);
    expect(canView(spectator, publicUnit)).toBe(true);
    expect(canView(spectator, dmSecret)).toBe(false);
    expect(canView(spectator, revealedToAlice)).toBe(false);
  });
});
