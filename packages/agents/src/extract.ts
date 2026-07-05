// extract() — turn a raw session transcript into durable campaign memory: a prose
// recap plus discrete knowledge units a player might later ask about. This is where
// the memory learns from actual play. Runs on Sonnet (extraction quality matters and
// it's a once-per-session cost, not per-question — see the pricing model).

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";

// The atom types a session can produce. RELATIONSHIP is excluded — it needs explicit
// subject/object unit ids, which belongs to a later linking pass, not free extraction.
export const EXTRACTABLE_TYPES = [
  "NPC",
  "LOCATION",
  "EVENT",
  "FACT",
  "LORE",
  "ITEM",
  "THREAD",
] as const;

export type ExtractedType = (typeof EXTRACTABLE_TYPES)[number];

export interface ExtractedUnit {
  type: ExtractedType;
  title: string;
  content: string;
}

export interface Extraction {
  recap: string;
  units: ExtractedUnit[];
}

const SYSTEM = `You are the archivist of a tabletop RPG campaign. You are given the raw, speaker-attributed transcript of one game session and must distill it into the campaign's memory.

The transcript is messy: it mixes in-fiction play with out-of-character table talk (dice, rules debates, snacks, scheduling). Capture ONLY what is true within the story.

Produce two things via the record_session tool:
1. recap — a tight, in-world prose summary of what happened this session (a few short paragraphs). Past tense, no meta-commentary about the players or the recording.
2. units — discrete facts a player might later ask the memory about. One unit per distinct NPC, location, event, revealed fact, notable item, or open thread/quest. Give each a short title and a self-contained content sentence or two.

Rules:
- Never invent details not supported by the transcript. If something is ambiguous, omit it.
- Ignore pure table logistics and OOC banter — they are not campaign memory.
- Prefer fewer, higher-signal units over many trivial ones.
- If nothing of substance happened, return a brief recap and an empty units list.`;

const TOOL: Anthropic.Tool = {
  name: "record_session",
  description:
    "Record the session recap and the knowledge units extracted from it.",
  input_schema: {
    type: "object",
    properties: {
      recap: {
        type: "string",
        description:
          "In-world prose summary of the session (a few short paragraphs).",
      },
      units: {
        type: "array",
        description: "Discrete knowledge atoms extracted from the session.",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [...EXTRACTABLE_TYPES],
              description: "The kind of knowledge atom.",
            },
            title: {
              type: "string",
              description: "Short label (a name or phrase).",
            },
            content: {
              type: "string",
              description: "Self-contained fact, one or two sentences.",
            },
          },
          required: ["type", "title", "content"],
        },
      },
    },
    required: ["recap", "units"],
  },
};

/** Distill a speaker-attributed transcript into a recap + knowledge units. */
export async function extractSession(transcript: string): Promise<Extraction> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8192, // a whole session's recap + units; forced tool_use must not truncate
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      { role: "user", content: `Session transcript:\n\n${transcript}` },
    ],
  });

  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block)
    throw new Error("extractSession: model returned no tool_use block");

  const input = block.input as { recap?: string; units?: ExtractedUnit[] };
  const validTypes = new Set<string>(EXTRACTABLE_TYPES);
  return {
    recap: input.recap?.trim() ?? "",
    units: (input.units ?? []).filter(
      (u) => u.title?.trim() && u.content?.trim() && validTypes.has(u.type),
    ),
  };
}
