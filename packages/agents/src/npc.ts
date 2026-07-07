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

You are given (1) an optional brief from the DM and (2) excerpts from the campaign's existing memory. Ground the NPC in that world: where it fits, reference real locations, factions, and existing NPCs by name so it feels native to THIS campaign, not generic fantasy. Honor the DM's brief where given; invent tastefully where it's silent.

Produce exactly one NPC via the record_npc tool:
- name, race, role — who they are.
- appearance — a vivid one-line physical description (species, build, dress, distinguishing features). This is used to match a portrait, so make it concrete and visual.
- demeanor — personality in a phrase.
- voice — how they speak / a mannerism.
- ties — concrete connections to existing people, factions, or places in the provided memory.
- hook — a reason the party would care; a thread they could pull.
- secret — something the DM knows that the NPC hides (DM-only).

Keep each field tight. Do not invent world facts that contradict the provided memory.`;

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
  const units = await retrieveForViewer(dmViewer, groundingQuery, 12);
  const context =
    units.map((u) => `- ${u.title} (${u.type}): ${u.content}`).join("\n") ||
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
 * NOTE: the DM-only secret rides in the content today — splitting it into its own unit for
 * safe partial reveal (reveal the NPC, not the secret) is a follow-up. */
export async function saveNpc(
  campaignId: string,
  draft: NpcDraft,
  imageStoragePath?: string,
): Promise<{ id: string }> {
  const content = [
    `${draft.race} ${draft.role}. ${draft.appearance}`,
    `Demeanor: ${draft.demeanor}`,
    `Voice: ${draft.voice}`,
    `Ties: ${draft.ties}`,
    `Hook: ${draft.hook}`,
    `DM secret: ${draft.secret}`,
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
  }
  return { id: unit.id };
}
