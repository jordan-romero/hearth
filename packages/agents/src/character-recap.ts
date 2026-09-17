// A session as each character lived it.
//
// The session recap is the whole table's story, and it can hold what only one character learned in
// the fiction: a whisper, a vision, a conversation in a room the others weren't in. Everyone at the
// table heard it said aloud, but only that character knows it. So each character who took part gets
// their own recap — what they were there for and learned, nothing told privately to someone else —
// and the same again in their own voice, as they'd remember it.
//
// When it's unclear whether a character learned something, it's left out. A player can always be
// told more (reveals, /share); nothing can take a spoiler back.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";
import { speakerLabel } from "./live.js";
import { getSpeakerLabels } from "./tenancy.js";

const MODEL = "claude-sonnet-5";
const CONCURRENCY = 3;

export interface RecapCharacter {
  id: string;
  name: string;
  pronouns?: string | null;
  ancestry?: string | null;
  class?: string | null;
}

export interface CharacterRecapText {
  characterId: string;
  summary: string;
  inCharacter: string;
}

const SYSTEM = `You are the archivist of a tabletop RPG campaign, writing last session's recap for ONE character. You are given the whole session's speaker-attributed transcript and who that character is.

The transcript is messy: it mixes in-fiction play with out-of-character table talk (dice, rules debates, snacks, scheduling). Only the story counts.

Everyone at the table heard everything said aloud — but characters only know what happened to them in the story. Write what THIS character experienced and learned:
- Include what happened where they were, what they did, and what they were told or discovered.
- Leave out anything another character learned privately: a whisper, a vision or dream, a telepathic message, a note only they read, a conversation in a place this character wasn't. Leave out the DM describing what someone else alone sees or knows.
- If it's unclear whether this character was present for something or learned it, leave it out.
- If the character barely took part, keep it short. Never invent events, feelings, or details the transcript doesn't support.

Record two versions with the record_character_recap tool:
1. summary — third person, past tense, plain and concrete, a few short paragraphs at most.
2. in_character — the same events told in the first person, as this character remembering last session, in a voice that fits them. The same facts as the summary, no more.`;

const TOOL: Anthropic.Tool = {
  name: "record_character_recap",
  description: "Record this character's recap of the session, in two versions.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Third person, past tense: what this character experienced and learned.",
      },
      in_character: {
        type: "string",
        description:
          "The same events in the first person, as the character remembers them.",
      },
    },
    required: ["summary", "in_character"],
  },
};

function describe(c: RecapCharacter): string {
  const bits = [c.pronouns, c.ancestry, c.class].filter(Boolean).join(", ");
  return bits ? `${c.name} (${bits})` : c.name;
}

async function recapFor(
  client: Anthropic,
  transcript: string,
  character: RecapCharacter,
): Promise<CharacterRecapText | null> {
  const msg = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 16_000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Session transcript:\n\n${transcript}`,
              // The same transcript for every character: written once, then read at a tenth.
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: `Write the recap for ${describe(character)}. In the transcript, lines labelled "${character.name}" are this character's player speaking.`,
            },
          ],
        },
      ],
    })
    .finalMessage();
  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  const input = block?.input as
    { summary?: unknown; in_character?: unknown } | undefined;
  const summary =
    typeof input?.summary === "string" ? input.summary.trim() : "";
  const inCharacter =
    typeof input?.in_character === "string" ? input.in_character.trim() : "";
  // A cut-off or empty recap is worse than none: the player would read half a session as if it
  // were all of it. They fall back to the table's recap instead.
  if (msg.stop_reason === "max_tokens" || !summary || !inCharacter) return null;
  return { characterId: character.id, summary, inCharacter };
}

/** One recap per character. A character whose recap fails is simply left out — the others still
 * get theirs, and that player sees the table's recap. */
export async function writeCharacterRecaps(
  transcript: string,
  characters: RecapCharacter[],
  client: Anthropic = new Anthropic(),
): Promise<{ recaps: CharacterRecapText[]; failed: number }> {
  const recaps: CharacterRecapText[] = [];
  let failed = 0;
  const one = async (c: RecapCharacter) => {
    try {
      const r = await recapFor(client, transcript, c);
      if (r) recaps.push(r);
      else failed++;
    } catch (err) {
      failed++;
      console.error(`[recap] character ${c.id} failed:`, err);
    }
  };
  // The first writes the transcript to the cache; the rest read it.
  if (characters.length) await one(characters[0]!);
  const rest = characters.slice(1);
  for (let i = 0; i < rest.length; i += CONCURRENCY)
    await Promise.all(rest.slice(i, i + CONCURRENCY).map(one));
  return { recaps, failed };
}

export type RecapChoice =
  | { kind: "table"; text: string }
  | { kind: "character"; text: string; voice: boolean };

/** What /recap shows. The DM gets the table's recap. A player gets their character's — in their
 * voice if they asked — or the table's recap when their character has none (they weren't recorded
 * taking part, or it couldn't be written). */
export function chooseRecap(
  role: "DM" | "PLAYER",
  tableRecap: string,
  own: { summary: string; inCharacter: string } | null,
  voice: boolean,
): RecapChoice {
  if (role === "DM" || !own) return { kind: "table", text: tableRecap };
  return voice
    ? { kind: "character", text: own.inCharacter, voice: true }
    : { kind: "character", text: own.summary, voice: false };
}

// ── For a whole session ──────────────────────────────────────────────────────────────────────────

/** Write (or rewrite) the recaps for every character recorded taking part in a session. The same
 * path the worker takes when a session finishes, and the one to run for a session finished before
 * this existed. */
export async function writeRecapsForSession(
  gameSessionId: string,
  client: Anthropic = new Anthropic(),
): Promise<{ characters: number; written: number; failed: number }> {
  const session = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    select: {
      campaignId: true,
      recordings: { select: { id: true } },
      attendance: {
        select: {
          character: {
            select: {
              id: true,
              name: true,
              pronouns: true,
              ancestry: true,
              class: true,
            },
          },
        },
      },
    },
  });
  if (!session) return { characters: 0, written: 0, failed: 0 };
  const characters = [
    ...new Map(
      session.attendance
        .flatMap((a) => (a.character ? [a.character] : []))
        .map((c) => [c.id, c]),
    ).values(),
  ];
  if (characters.length === 0) return { characters: 0, written: 0, failed: 0 };

  const segments = await prisma.transcriptSegment.findMany({
    where: {
      recordingId: { in: session.recordings.map((r) => r.id) },
      isLive: false,
    },
    orderBy: [{ recording: { startedAt: "asc" } }, { startMs: "asc" }],
    include: { character: { select: { name: true } } },
  });
  if (segments.length === 0)
    return { characters: characters.length, written: 0, failed: 0 };
  const labels = await getSpeakerLabels(session.campaignId);
  const transcript = segments
    .map((s) => `${speakerLabel(s, labels)}: ${s.text}`)
    .join("\n");

  const { recaps, failed } = await writeCharacterRecaps(
    transcript,
    characters,
    client,
  );
  for (const r of recaps)
    await prisma.characterRecap.upsert({
      where: {
        gameSessionId_characterId: {
          gameSessionId,
          characterId: r.characterId,
        },
      },
      create: { gameSessionId, ...r },
      update: { summary: r.summary, inCharacter: r.inCharacter },
    });
  return { characters: characters.length, written: recaps.length, failed };
}
