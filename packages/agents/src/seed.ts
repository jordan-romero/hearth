// ─── Hearth seed: The Shepherds of Ondera ────────────────────────────────────
// A curated slice of Jordan's real campaign, used to exercise the memory +
// permission filter end-to-end. Everything is namespaced `seed-*` and lives in
// its own campaign so it can NEVER collide with a future full Ondera upload.
//
// Run: pnpm --filter @hearth/agents seed
//
// The fog-of-war designations here are staged for the DEMO (none of this is
// truly secret from Jordan) — a few DM-only units + one revealed to Morwyn only,
// so the filter has something real to hide and reveal.

import { prisma } from "@hearth/db";
import { embedTexts, EMBEDDING_MODEL, toVectorLiteral } from "./embeddings.js";

const CAMPAIGN_ID = "seed-ondera";
const PARTY_ID = "seed-party-shepherds";

// character ids (referenced by grants)
const MORWYN = "seed-char-morwyn";

const MEM_DM = "seed-mem-dm";

const users = [
  { id: "seed-user-dm", email: "dm@ondera.seed", name: "Dungeon Master" },
  { id: "seed-user-jordan", email: "jordan@ondera.seed", name: "Jordan" },
  { id: "seed-user-jake", email: "jake@ondera.seed", name: "Jake" },
  { id: "seed-user-grayson", email: "grayson@ondera.seed", name: "Grayson" },
  { id: "seed-user-patrick", email: "patrick@ondera.seed", name: "Patrick" },
  { id: "seed-user-dustin", email: "dustin@ondera.seed", name: "Dustin" },
];

const memberships = [
  { id: MEM_DM, userId: "seed-user-dm", role: "DM" as const },
  {
    id: "seed-mem-jordan",
    userId: "seed-user-jordan",
    role: "PLAYER" as const,
  },
  { id: "seed-mem-jake", userId: "seed-user-jake", role: "PLAYER" as const },
  {
    id: "seed-mem-grayson",
    userId: "seed-user-grayson",
    role: "PLAYER" as const,
  },
  {
    id: "seed-mem-patrick",
    userId: "seed-user-patrick",
    role: "PLAYER" as const,
  },
  {
    id: "seed-mem-dustin",
    userId: "seed-user-dustin",
    role: "PLAYER" as const,
  },
];

const characters = [
  {
    id: MORWYN,
    membershipId: "seed-mem-jordan",
    name: "Morwyn Poppinstone",
    class: "Cleric",
    ancestry: "Dwarf",
    level: 10,
  },
  {
    id: "seed-char-ildin",
    membershipId: "seed-mem-jake",
    name: "Ildin",
    class: "Warlock",
    ancestry: null,
    level: 10,
  },
  {
    id: "seed-char-arvid",
    membershipId: "seed-mem-grayson",
    name: "Arvid",
    class: "Druid",
    ancestry: "Aarakocra",
    level: 10,
  },
  {
    id: "seed-char-dalakhi",
    membershipId: "seed-mem-patrick",
    name: "Dalakhi",
    class: "Ranger",
    ancestry: "Halfling",
    level: 10,
  },
  {
    id: "seed-char-zulgar",
    membershipId: "seed-mem-dustin",
    name: "Zulgar",
    class: null,
    ancestry: null,
    level: 10,
  },
];

type UnitType =
  | "NPC"
  | "LOCATION"
  | "EVENT"
  | "FACT"
  | "LORE"
  | "ITEM"
  | "RELATIONSHIP"
  | "THREAD";
type UnitSource = "SESSION" | "DM_ADDED";
type UnitVis = "EVERYONE" | "DM_ONLY" | "PUBLIC";
type UnitOrigin = "PLAYED" | "AUTHORED" | "GENERATED";

interface SeedUnit {
  id: string;
  type: UnitType;
  source: UnitSource;
  visibility: UnitVis;
  title: string;
  content: string;
  origin?: UnitOrigin;
  subjectId?: string;
  objectId?: string;
}

// Referenced-by-relationship units must precede the relationship unit.
const units: SeedUnit[] = [
  // ── NPCs (known to the table) ──────────────────────────────────────────────
  {
    id: "seed-ku-hesalandra",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Hesalandra, the Solar",
    content:
      "An angel (Solar) of Hestith who now possesses Morwyn's body, driven to return to her goddess and viewing the party as obstacles to be removed.",
  },
  {
    id: "seed-ku-shadow-seeker",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "The Shadow Seeker",
    content:
      "Lord of the Penumbral Court in the Feywild and Ildin's warlock patron. Once possessed Ildin directly; freed, for now, by Zulgar's remedy.",
  },
  {
    id: "seed-ku-gefk",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Gefk",
    content:
      "The first orc to arise from the earth after the Reckoning, dying and resurrecting endlessly. Reforged at Ret'ah'pah into a champion of Yashwin, then slain by Arvid with Divine Reaper.",
  },
  {
    id: "seed-ku-moira",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Moira Poppinstone",
    content:
      "Morwyn's late mother, Fae-touched like her daughter. Left behind codices with hidden notes concealed in the bindings, discovered at Ret'ah'pah.",
  },
  {
    id: "seed-ku-savile",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Savile",
    content:
      "A seven-year-old boy conjured aboard the airship by his priest father to escape persecution of Hestith worshippers in Nampa. Dreams of flying; cared for by Olda and Garvin.",
  },
  {
    id: "seed-ku-remnan",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Remnan",
    content:
      "An elderly former tailor of Earthspire, now a crew member aboard the airship. Left the Fey courts deliberately, and asked Ildin to keep the Shadow Seeker out of his sight — a request honored.",
  },
  {
    id: "seed-ku-juniper",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Juniper",
    content:
      "A resident of Wendire given the deed to Morwyn's Poppinstone potion shop.",
  },
  {
    id: "seed-ku-puwstice",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Puwstice",
    content:
      "An unexpectedly friendly hag from a Feywild-adjacent domain who ran a dungeon crawl for the party in exchange for bargains offered to each member.",
  },
  {
    id: "seed-ku-quimbley",
    type: "NPC",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Quintus Quimbley",
    content:
      "An inkery owner in the town of Dark revealed as the antagonist of the early arc. He burned Dark to the ground and fled.",
  },

  // ── Locations ──────────────────────────────────────────────────────────────
  {
    id: "seed-ku-earthspire",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Earthspire",
    content:
      "A tiered city on the western continent and a long-term hub for the Shepherds; site of Moira's funeral and a former hideout.",
  },
  {
    id: "seed-ku-dark",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Dark",
    content:
      "An early-campaign hub town on the western continent, burned during Quintus Quimbley's attack.",
  },
  {
    id: "seed-ku-wendire",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Wendire",
    content:
      "A western-continent town home to a Poppinstone potion shop, whose deed was given to Juniper.",
  },
  {
    id: "seed-ku-nampa",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Nampa (Na'ampa)",
    content:
      "A western-hemisphere city where worshippers of Hestith are being persecuted; Savile's home temple.",
  },
  {
    id: "seed-ku-spalt",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Spalt",
    content:
      "A drought-stricken town in the western hemisphere; the party's current destination, one day away by airship.",
  },
  {
    id: "seed-ku-retahpah",
    type: "LOCATION",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Ret'ah'pah",
    content:
      "An ancient ruined temple on the eastern continent of Hira, housing a font of ancient power over a river of lava. Site of Gefk's reforging; it collapsed as the party escaped.",
  },

  // ── Lore ───────────────────────────────────────────────────────────────────
  {
    id: "seed-ku-reckoning",
    type: "LORE",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "The Reckoning",
    content:
      "A world-altering cataclysm that reshaped Ondera's geography, civilization, and the bond between mortals and gods. Buildings were ripped into the atmosphere and sunk; the Poppinstone ancestors emerged from the earth in its aftermath.",
  },
  {
    id: "seed-ku-hestith",
    type: "LORE",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Hestith",
    content:
      "The goddess Morwyn serves as a Life cleric. She gifted the first Poppinstone ancestor a hammer directly after the Reckoning.",
  },
  {
    id: "seed-ku-yashwin",
    type: "LORE",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Yashwin",
    content:
      "A god who claimed Gefk and reforged him into a champion at Ret'ah'pah. When Arvid killed Gefk, Yashwin screamed, and Hestith briefly vanished from the world.",
  },
  {
    id: "seed-ku-feywild",
    type: "LORE",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "The Feywild & the Penumbral Court",
    content:
      "The Fey realm, where the Shadow Seeker rules the Penumbral Court. The courts are at war; Morwyn is Fae-touched.",
  },

  // ── Events (session-derived) ───────────────────────────────────────────────
  {
    id: "seed-ku-angel-brain",
    type: "EVENT",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Morwyn consumes the angel brain",
    content:
      "At Ret'ah'pah, Morwyn consumed the brain of Hesalandra, a Solar of Hestith — and was possessed by her. (Session 85)",
  },
  {
    id: "seed-ku-gefk-death",
    type: "EVENT",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "The death of Gefk",
    content:
      "Arvid killed Gefk, champion of Yashwin, with Divine Reaper at Ret'ah'pah. The god Yashwin screamed.",
  },
  {
    id: "seed-ku-retahpah-fall",
    type: "EVENT",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "The fall of Ret'ah'pah",
    content:
      "The ancient temple collapsed after Gefk's death; the party escaped as the ceiling came down.",
  },

  // ── Open threads (known to be unresolved) ──────────────────────────────────
  {
    id: "seed-ku-thread-free-morwyn",
    type: "THREAD",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "How can Morwyn be freed from Hesalandra?",
    content:
      "The party seeks a way to expel the Solar Hesalandra from Morwyn's body before she kills them.",
  },
  {
    id: "seed-ku-thread-ildin-influence",
    type: "THREAD",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "How much does the Shadow Seeker still influence Ildin?",
    content:
      "The party suspects the Shadow Seeker's grip on Ildin persists despite Zulgar's remedy, but has no confirmation.",
  },
  {
    id: "seed-ku-thread-moira-notes",
    type: "THREAD",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "What do Moira's hidden notes say?",
    content:
      "Moira Poppinstone concealed notes in the bindings of her codices, discovered at Ret'ah'pah but not yet deciphered.",
  },

  // ── Relationship (rides the graph via subject/object) ──────────────────────
  {
    id: "seed-ku-rel-gefk-yashwin",
    type: "RELATIONSHIP",
    source: "SESSION",
    visibility: "EVERYONE",
    title: "Gefk served Yashwin",
    content:
      "Gefk was reforged into, and served as, a champion of the god Yashwin.",
    subjectId: "seed-ku-gefk",
    objectId: "seed-ku-yashwin",
  },

  // ── DM-only secrets (gated — the filter must hide these from players) ───────
  {
    id: "seed-ku-secret-gefk-spy",
    type: "FACT",
    source: "DM_ADDED",
    visibility: "DM_ONLY",
    origin: "AUTHORED",
    title: "SECRET: Gefk was Yashwin's spy",
    content:
      "Yashwin planted Gefk as a spy to uncover Hestith's plans; the endless cycle of death and resurrection was Yashwin's design all along.",
  },
  {
    id: "seed-ku-secret-shadow-influence",
    type: "FACT",
    source: "DM_ADDED",
    visibility: "DM_ONLY",
    origin: "AUTHORED",
    title: "SECRET: The Shadow Seeker still grips Ildin",
    content:
      "Despite Zulgar's remedy freeing Ildin from active possession, the Shadow Seeker still secretly influences him — the party only suspects it.",
  },

  // ── DM-only, but revealed to Morwyn alone (per-character grant demo) ────────
  {
    id: "seed-ku-secret-arvid-reincarnate",
    type: "FACT",
    source: "DM_ADDED",
    visibility: "DM_ONLY",
    origin: "AUTHORED",
    title: "Arvid's hidden Reincarnate preparation",
    content:
      "Before Ildin's trial, Arvid secretly prepared 1,000 gp of Reincarnate components (oils and unguents) — a quiet contingency for Ildin's death. Morwyn discovered it.",
  },
];

async function main() {
  console.log("🌱 Seeding: The Shepherds of Ondera\n");

  // Users are global — upsert them (survive a re-seed).
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { email: u.email, name: u.name },
      create: u,
    });
  }

  // Wipe + recreate the campaign (cascades memberships/characters/units/grants).
  await prisma.campaign.deleteMany({ where: { id: CAMPAIGN_ID } });
  await prisma.campaign.create({
    data: {
      id: CAMPAIGN_ID,
      name: "Shepherds of Ondera — Hearth Seed",
      theme: "firelight",
    },
  });

  for (const m of memberships) {
    await prisma.membership.create({
      data: {
        id: m.id,
        userId: m.userId,
        campaignId: CAMPAIGN_ID,
        role: m.role,
      },
    });
  }

  await prisma.party.create({
    data: { id: PARTY_ID, campaignId: CAMPAIGN_ID, name: "The Shepherds" },
  });

  for (const c of characters) {
    await prisma.character.create({
      data: {
        id: c.id,
        campaignId: CAMPAIGN_ID,
        membershipId: c.membershipId,
        partyId: PARTY_ID,
        name: c.name,
        class: c.class ?? undefined,
        ancestry: c.ancestry ?? undefined,
        level: c.level,
      },
    });
  }

  for (const k of units) {
    await prisma.knowledgeUnit.create({
      data: {
        id: k.id,
        campaignId: CAMPAIGN_ID,
        type: k.type,
        source: k.source,
        origin: k.origin ?? "PLAYED",
        baseVisibility: k.visibility,
        title: k.title,
        content: k.content,
        subjectId: k.subjectId,
        objectId: k.objectId,
      },
    });
  }
  console.log(
    `  ✓ ${users.length} users, ${characters.length} characters, ${units.length} knowledge units`,
  );

  // Embed every unit's title+content in one Voyage batch, then store the vectors.
  console.log(`  … embedding ${units.length} units via ${EMBEDDING_MODEL}`);
  const vectors = await embedTexts(
    units.map((k) => `${k.title}. ${k.content}`),
    "document",
  );
  for (let i = 0; i < units.length; i++) {
    const vec = vectors[i];
    if (!vec) throw new Error(`No embedding for ${units[i]!.id}`);
    await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${units[i]!.id}`;
  }
  console.log(`  ✓ embeddings stored (${vectors[0]?.length}-dim)`);

  // Reveal one DM-only secret to Morwyn alone (she discovered it) + audit it.
  await prisma.knowledgeGrant.create({
    data: {
      id: "seed-grant-arvid-to-morwyn",
      knowledgeUnitId: "seed-ku-secret-arvid-reincarnate",
      characterId: MORWYN,
      revealedByMembershipId: MEM_DM,
    },
  });
  await prisma.revealEvent.create({
    data: {
      knowledgeUnitId: "seed-ku-secret-arvid-reincarnate",
      action: "REVEAL",
      characterId: MORWYN,
      byMembershipId: MEM_DM,
      note: "Morwyn discovered Arvid's preparation.",
    },
  });
  console.log(
    "  ✓ 1 grant (Arvid's secret → Morwyn), 3 DM-only secrets total\n",
  );
  console.log("🔥 Seed complete.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
