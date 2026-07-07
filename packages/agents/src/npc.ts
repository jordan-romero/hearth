// generateNpc() — invent an NPC on demand, GROUNDED in the campaign's memory so it references
// real people, places, and factions instead of generic fantasy. Runs on Sonnet (generation
// quality matters and it's once-per-NPC, not per-question). The `appearance` field is written
// for portrait matching; the `secret` is DM-only. The result is a DRAFT — the DM accepts,
// edits, or regenerates before anything is saved.

import Anthropic from "@anthropic-ai/sdk";
import type { Viewer } from "@hearth/core";
import { prisma } from "@hearth/db";
import { retrieveForViewer } from "./retrieve.js";
import { embedTexts, toVectorLiteral } from "./embeddings.js";

const MODEL = "claude-sonnet-5";

/** In-place Fisher–Yates shuffle (uniform — unlike sort(() => random)). Returns the array. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export interface NpcDraft {
  name: string;
  race: string;
  role: string;
  appearance: string; // physical look — the text half of portrait matching
  demeanor: string;
  voice: string;
  ties: string;
  hook: string;
  secret: string; // DM-only
}

const SYSTEM = `You are the loremaster of a tabletop RPG campaign, inventing a single NPC for the Dungeon Master.

The DM's brief is the SPECIFICATION — match the race, gender, role, and any traits it names EXACTLY. (If the brief is empty, invent someone who fits the campaign.)

You are also given excerpts from the campaign's memory. Those excerpts are the SOURCE OF TRUTH about this world: treat their names, places, factions, and events as authoritative and NEVER contradict them. You may draw on your general knowledge of fantasy and tabletop RPGs to flesh the character out, but whenever it touches this campaign's world, the provided material wins. Where it fits NATURALLY, weave in a connection to a real location, faction, or NPC from the excerpts so the character feels native to this world — but DON'T force it: most NPCs are ordinary people with their own lives, not tied to the main plot. Vary origins, names, and affiliations widely; never cluster every NPC around the same few factions or places.

Produce exactly one NPC via the record_npc tool:
- name, race, role — who they are.
- appearance — a vivid one-line physical description (species, build, dress, distinguishing features). This is used to match a portrait, so make it concrete and visual.
- demeanor — personality in a phrase.
- voice — how they speak / a mannerism.
- ties — concrete connections to existing people, factions, or places in the provided memory.
- hook — a reason the party would care; a thread they could pull.
- secret — something the DM knows that the NPC hides (DM-only).

Invent a NEW, distinct character — never reproduce or lightly reskin an NPC already present in the provided memory. Keep each field tight. Do not invent world facts that contradict the provided memory.`;

const NPC_TOOL: Anthropic.Tool = {
  name: "record_npc",
  description: "Record the generated NPC.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      race: { type: "string" },
      role: { type: "string" },
      appearance: {
        type: "string",
        description:
          "Vivid one-line physical description for portrait matching.",
      },
      demeanor: { type: "string" },
      voice: { type: "string" },
      ties: {
        type: "string",
        description:
          "Connections to existing NPCs, factions, or places by name.",
      },
      hook: { type: "string" },
      secret: { type: "string", description: "DM-only secret the NPC hides." },
    },
    required: [
      "name",
      "race",
      "role",
      "appearance",
      "demeanor",
      "voice",
      "ties",
      "hook",
      "secret",
    ],
  },
};

/** Generate one NPC, grounded in the campaign's memory. `prompt` is the DM's optional brief. */
export async function generateNpc(
  campaignId: string,
  prompt?: string,
): Promise<NpcDraft> {
  // Pull grounding context as the DM (sees everything) — real names to weave in.
  const dmViewer: Viewer = {
    campaignId,
    role: "DM",
    characterId: null,
    partyId: null,
  };
  const groundingQuery =
    prompt?.trim() || "notable people, factions, and places in the campaign";
  // Over-fetch, then randomly sample a subset so regenerations see a DIFFERENT slice of the
  // world each time — otherwise the same top units come back and NPCs converge on the same ties.
  const pool = await retrieveForViewer(dmViewer, groundingQuery, 24);
  const sampled = shuffle(pool.slice()).slice(0, 8);
  const context =
    sampled.map((u) => `- ${u.title} (${u.type}): ${u.content}`).join("\n") ||
    "(the campaign memory is still sparse — invent freely but coherently)";

  const brief = prompt?.trim()
    ? `DM brief: ${prompt.trim()}`
    : "DM brief: (none — invent an NPC that fits the campaign)";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: [NPC_TOOL],
    tool_choice: { type: "tool", name: NPC_TOOL.name },
    messages: [
      {
        role: "user",
        content: `${brief}\n\nCampaign memory excerpts:\n${context}`,
      },
    ],
  });

  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block) throw new Error("generateNpc: model returned no tool_use block");
  return block.input as NpcDraft;
}

/** Persist an accepted NPC as a GENERATED, DM_ONLY KnowledgeUnit (+ its matched portrait key),
 * embedded for retrieval. Shared so the bot and a future web "accept" both save identically.
 * The DM-only SECRET is stored as a SEPARATE unit (linked via subjectId), so the DM can reveal
 * the NPC to players without leaking the secret — the secret unit stays DM_ONLY. */
export async function saveNpc(
  campaignId: string,
  draft: NpcDraft,
  imageStoragePath?: string,
): Promise<{ id: string; secretId?: string }> {
  // The NPC unit — everything EXCEPT the secret, so revealing it to players is safe.
  const content = [
    `${draft.race} ${draft.role}. ${draft.appearance}`,
    `Demeanor: ${draft.demeanor}`,
    `Voice: ${draft.voice}`,
    `Ties: ${draft.ties}`,
    `Hook: ${draft.hook}`,
  ].join("\n");

  const unit = await prisma.knowledgeUnit.create({
    data: {
      campaignId,
      type: "NPC",
      source: "DM_ADDED",
      origin: "GENERATED",
      baseVisibility: "DM_ONLY",
      title: draft.name,
      content,
      imageStoragePath: imageStoragePath ?? null,
    },
  });
  const [vec] = await embedTexts([`${draft.name}. ${content}`], "document");
  if (vec) {
    await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${unit.id}`;
  } else {
    console.warn(
      `saveNpc: NPC ${unit.id} saved without an embedding (won't be retrievable)`,
    );
  }

  // The secret — its own DM_ONLY unit, linked to the NPC. Never revealed alongside the NPC.
  let secretId: string | undefined;
  if (draft.secret?.trim()) {
    const secret = await prisma.knowledgeUnit.create({
      data: {
        campaignId,
        type: "FACT",
        source: "DM_ADDED",
        origin: "GENERATED",
        baseVisibility: "DM_ONLY",
        title: `Secret — ${draft.name}`,
        content: draft.secret.trim(),
        subjectId: unit.id,
      },
    });
    secretId = secret.id;
    const [svec] = await embedTexts(
      [`Secret about ${draft.name}. ${draft.secret.trim()}`],
      "document",
    );
    if (svec) {
      await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(svec)}::vector WHERE id = ${secret.id}`;
    } else {
      console.warn(`saveNpc: secret ${secret.id} saved without an embedding`);
    }
  }
  return { id: unit.id, secretId };
}
