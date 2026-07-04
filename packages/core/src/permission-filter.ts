// ─── THE SPINE ───────────────────────────────────────────────────────────────
// The single permission filter. bot / web / worker all call THIS and nothing
// re-implements it. It is a PURE function — no DB, no I/O. Retrieval loads the
// candidate units (with their grants attached) and calls this; the model only
// ever sees the filtered result, so it cannot leak what it was never given.
//
// Rules (from docs/scope.md):
//   1. Cross-campaign knowledge is never returned — the hard multi-tenant line.
//   2. The DM sees the whole world within their campaign.
//   3. A player sees: EVERYONE/PUBLIC units, units granted to their character,
//      and units granted to their party. Never DM_ONLY without a matching grant.
//   4. SESSION knowledge is fair game because it is *stored* as EVERYONE — the
//      two-tier rule is applied at write time, so the filter only reads state.

export type ViewerRole = "DM" | "PLAYER";

/** Mirrors the Prisma `BaseVisibility` enum. Kept local so the spine has no runtime deps. */
export type Visibility = "DM_ONLY" | "EVERYONE" | "PUBLIC";

/** Who is asking. The filter is a pure function of this + the candidate units. */
export interface Viewer {
  campaignId: string;
  role: ViewerRole;
  /** The character a player is viewing as. `null` for the DM (or a character-less viewer). */
  characterId: string | null;
  /** The viewer's party, if any. */
  partyId: string | null;
}

/** The minimal shape the filter needs — a unit plus the grants already loaded for it. */
export interface FilterableKnowledgeUnit {
  id: string;
  campaignId: string;
  baseVisibility: Visibility;
  /** character ids this unit has been revealed to (CHARACTER grants). */
  grantedCharacterIds: string[];
  /** party ids this unit has been revealed to (PARTY grants). */
  grantedPartyIds: string[];
}

/** Can this one viewer know this one unit? The whole rule, in one place. */
export function canView(viewer: Viewer, unit: FilterableKnowledgeUnit): boolean {
  // 1. Hard campaign boundary — applies to everyone, the DM included.
  if (unit.campaignId !== viewer.campaignId) return false;

  // 2. The DM sees the whole world within their campaign.
  if (viewer.role === "DM") return true;

  // 3. Broadly-visible knowledge (incl. SESSION facts, stored as EVERYONE).
  if (unit.baseVisibility === "EVERYONE" || unit.baseVisibility === "PUBLIC") {
    return true;
  }

  // 4. Targeted reveals ("reveal in pieces") — to this character, or their party.
  if (
    viewer.characterId !== null &&
    unit.grantedCharacterIds.includes(viewer.characterId)
  ) {
    return true;
  }
  if (
    viewer.partyId !== null &&
    unit.grantedPartyIds.includes(viewer.partyId)
  ) {
    return true;
  }

  // 5. DM_ONLY with no matching grant — never.
  return false;
}

/** Return only the units the viewer is permitted to know. */
export function filterKnowledge(
  viewer: Viewer,
  units: FilterableKnowledgeUnit[],
): FilterableKnowledgeUnit[] {
  return units.filter((unit) => canView(viewer, unit));
}
