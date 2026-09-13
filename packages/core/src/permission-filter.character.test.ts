import { describe, it, expect } from "vitest";
import {
  filterKnowledge,
  filterKnownToCharacter,
  type CharacterSubject,
  type FilterableKnowledgeUnit,
  type Viewer,
} from "./permission-filter.js";

// A character page is read by people other than that character. Every case below pairs what a
// viewer may see on someone's page with what they must NOT.

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

const ids = (units: FilterableKnowledgeUnit[]) => units.map((u) => u.id).sort();

const dm: Viewer = {
  campaignId: "c1",
  role: "DM",
  characterId: null,
  partyId: null,
};
const alice: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: "char-alice",
  partyId: "party-1",
};
const bob: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: "char-bob",
  partyId: "party-2",
};
const carol: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: "char-carol",
  partyId: "party-1",
};
const seatless: Viewer = {
  campaignId: "c1",
  role: "PLAYER",
  characterId: null,
  partyId: null,
};
const dmOfC2: Viewer = {
  campaignId: "c2",
  role: "DM",
  characterId: null,
  partyId: null,
};

const aliceSubject: CharacterSubject = {
  campaignId: "c1",
  characterId: "char-alice",
  partyId: "party-1",
};

const sessionFact = unit({ id: "k-session", baseVisibility: "EVERYONE" });
const dmSecret = unit({ id: "k-secret", baseVisibility: "DM_ONLY" });
const toAlice = unit({
  id: "k-to-alice",
  baseVisibility: "DM_ONLY",
  grantedCharacterIds: ["char-alice"],
});
const aliceJournal = unit({
  id: "k-alice-journal",
  baseVisibility: "DM_ONLY",
  grantedCharacterIds: ["char-alice"],
});
const toParty1 = unit({
  id: "k-to-party1",
  baseVisibility: "DM_ONLY",
  grantedPartyIds: ["party-1"],
});
const toBob = unit({
  id: "k-to-bob",
  baseVisibility: "DM_ONLY",
  grantedCharacterIds: ["char-bob"],
});
const otherCampaign = unit({
  id: "k-c2",
  campaignId: "c2",
  baseVisibility: "EVERYONE",
  grantedCharacterIds: ["char-alice"],
});

const all = [
  sessionFact,
  dmSecret,
  toAlice,
  aliceJournal,
  toParty1,
  toBob,
  otherCampaign,
];

describe("filterKnownToCharacter — a character's page, seen by others", () => {
  it("shows the DM everything the character knows, and nothing they don't", () => {
    const seen = ids(filterKnownToCharacter(dm, aliceSubject, all));
    expect(seen).toEqual(
      ["k-alice-journal", "k-session", "k-to-alice", "k-to-party1"].sort(),
    );
    expect(seen).not.toContain("k-secret");
    expect(seen).not.toContain("k-to-bob");
  });

  it("matches the ordinary filter when a player opens their own page", () => {
    expect(ids(filterKnownToCharacter(alice, aliceSubject, all))).toEqual(
      ids(filterKnowledge(alice, all)),
    );
  });

  it("never shows another player what was revealed to the character", () => {
    const seen = ids(filterKnownToCharacter(bob, aliceSubject, all));
    expect(seen).toEqual(["k-session"]);
    expect(seen).not.toContain("k-to-alice");
    expect(seen).not.toContain("k-alice-journal");
    expect(seen).not.toContain("k-to-party1");
  });

  it("does not show a viewer's own secrets as if the character knew them", () => {
    expect(ids(filterKnownToCharacter(bob, aliceSubject, all))).not.toContain(
      "k-to-bob",
    );
  });

  it("shows a party-mate the party's reveals but not the character's own", () => {
    const seen = ids(filterKnownToCharacter(carol, aliceSubject, all));
    expect(seen).toEqual(["k-session", "k-to-party1"].sort());
    expect(seen).not.toContain("k-to-alice");
    expect(seen).not.toContain("k-alice-journal");
  });

  it("gives a player without a character only what the whole table knows", () => {
    expect(ids(filterKnownToCharacter(seatless, aliceSubject, all))).toEqual([
      "k-session",
    ]);
  });

  it("holds the campaign boundary for a DM of another campaign", () => {
    expect(filterKnownToCharacter(dmOfC2, aliceSubject, all)).toEqual([]);
  });

  it("returns nothing when the character belongs to a different campaign", () => {
    const elsewhere: CharacterSubject = { ...aliceSubject, campaignId: "c2" };
    expect(filterKnownToCharacter(dm, elsewhere, all)).toEqual([]);
  });
});
