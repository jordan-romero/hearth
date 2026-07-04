// ─── THE SPINE ───────────────────────────────────────────────────────────────
// The single permission filter. bot / web / worker all call THIS function and
// nothing re-implements it. Given a viewer, it returns only the knowledge units
// they are allowed to know. Retrieval runs candidates through here BEFORE Claude
// ever sees them, so the model cannot leak what it was never given.
//
// Rules (from the product plan):
//   1. SESSION-sourced knowledge is fair game to the table (campaign members).
//   2. DM_ADDED knowledge is DM-only until the DM grants visibility, in pieces.
//   3. A player only ever sees: EVERYONE units, their PARTY's granted units,
//      and units granted to them specifically. Never DM_ONLY, never another
//      party's gated knowledge.
//
// This file is intentionally a skeleton — the real implementation and its
// exhaustive test suite are Phase 0's core deliverable, written once the schema
// models exist.

export type ViewerRole = "DM" | "PLAYER";

/** Who is asking. The filter is a pure function of this + the candidate units. */
export interface Viewer {
  campaignId: string;
  membershipId: string;
  role: ViewerRole;
  /** null for the DM or a party-less member. */
  partyId: string | null;
}

/** Minimal shape the filter needs from a knowledge unit to make its decision. */
export interface FilterableKnowledgeUnit {
  id: string;
  campaignId: string;
  source: "SESSION" | "DM_ADDED";
  visibility: "DM_ONLY" | "PLAYERS" | "PARTY" | "EVERYONE" | "PUBLIC";
  /** party ids this unit has been revealed to (for PARTY grants). */
  grantedPartyIds: string[];
  /** membership ids this unit has been revealed to (for PLAYERS grants). */
  grantedMembershipIds: string[];
}

/**
 * Return only the units `viewer` is permitted to know.
 * PLACEHOLDER — implemented in Phase 0 alongside its test suite.
 */
export function filterKnowledge(
  _viewer: Viewer,
  _units: FilterableKnowledgeUnit[],
): FilterableKnowledgeUnit[] {
  throw new Error("filterKnowledge not implemented yet — Phase 0 deliverable");
}
