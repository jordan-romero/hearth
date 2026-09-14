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

const DOC_SYSTEM = `You are the archivist of a tabletop RPG campaign. You are given the text of one of the DM's documents (notes, a handout, lore, an NPC dossier), possibly one section of a longer document, and must distill it into discrete knowledge units for the campaign's memory.

Produce, via the record_units tool, the distinct facts someone might later ask the memory about — one unit per NPC, location, event, revealed fact, notable item, or open thread/quest. Give each a short title and a self-contained content sentence or two.

Keep secrets apart. A document often mixes what is known about something with what only the DM knows: a hidden motive, a true identity, a twist, a trap, a plan the characters haven't uncovered. Put that hidden part in the unit's secret field and keep it out of content, so content is safe to show a player who has met the subject. Leave secret out when nothing is hidden.

Rules:
- Never invent details not in the text. If something is ambiguous, omit it.
- Title a unit with its subject's name, so facts about the same subject from different sections line up.
- Prefer fewer, higher-signal units over many trivial ones.
- If the text contains nothing of substance, return an empty units list.`;

const UNITS_TOOL: Anthropic.Tool = {
  name: "record_units",
  description: "Record the knowledge units extracted from the document.",
  input_schema: {
    type: "object",
    properties: {
      units: {
        type: "array",
        description: "Discrete knowledge atoms extracted from the document.",
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
              description:
                "Self-contained fact, one or two sentences, safe to show a player who has met the subject.",
            },
            secret: {
              type: "string",
              description:
                "What only the DM should know about this subject (hidden motive, true identity, twist). Omit if nothing is hidden.",
            },
          },
          required: ["type", "title", "content"],
        },
      },
    },
    required: ["units"],
  },
};

/** A fact from a DM document, with anything only the DM should know held apart. */
export interface ExtractedDocUnit extends ExtractedUnit {
  secret?: string;
}

/** Characters per extraction window. Large, because each window is a separate model call. */
export const EXTRACTION_WINDOW = 24_000;

function splitLong(paragraph: string, size: number): string[] {
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > size) {
    const slice = rest.slice(0, size);
    const cut = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
    const end = cut > size * 0.5 ? cut + 1 : size;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Split a document into windows of about `size` characters, breaking at paragraph edges, so
 * each extraction call covers a manageable section. One request per document capped how much
 * the model could write back, and a long notebook lost most of its facts. */
export function extractionWindows(
  text: string,
  size = EXTRACTION_WINDOW,
): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > size ? splitLong(p, size) : [p]));

  const windows: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      windows.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) windows.push(current);
  return windows;
}

function joinDistinct(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!right || left.includes(right)) return left;
  if (!left || right.includes(left)) return right;
  return `${left} ${right}`;
}

const subjectKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Fold facts about the same subject (same title, ignoring case and punctuation) into one.
 * The first mention sets the type; distinct content and secrets are both kept, in order. */
export function mergeDocUnits(units: ExtractedDocUnit[]): ExtractedDocUnit[] {
  const bySubject = new Map<string, ExtractedDocUnit>();
  for (const unit of units) {
    const key = subjectKey(unit.title);
    if (!key) continue;
    const seen = bySubject.get(key);
    if (!seen) {
      bySubject.set(key, { ...unit });
      continue;
    }
    seen.content = joinDistinct(seen.content, unit.content);
    const secret = joinDistinct(seen.secret ?? "", unit.secret ?? "");
    if (secret) seen.secret = secret;
  }
  return [...bySubject.values()];
}

async function extractWindow(
  client: Anthropic,
  text: string,
): Promise<ExtractedDocUnit[]> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: DOC_SYSTEM,
    tools: [UNITS_TOOL],
    tool_choice: { type: "tool", name: UNITS_TOOL.name },
    messages: [{ role: "user", content: `Document:\n\n${text}` }],
  });

  const block = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block)
    throw new Error("extractUnitsFromText: model returned no tool_use block");

  const input = block.input as { units?: ExtractedDocUnit[] };
  const validTypes = new Set<string>(EXTRACTABLE_TYPES);
  return (input.units ?? [])
    .filter(
      (u) => u.title?.trim() && u.content?.trim() && validTypes.has(u.type),
    )
    .map((u) => ({
      type: u.type,
      title: u.title.trim(),
      content: u.content.trim(),
      ...(u.secret?.trim() ? { secret: u.secret.trim() } : {}),
    }));
}

/** Extract discrete knowledge units from a document's text (no recap), reading it section by
 * section and merging what each section says about the same subject. */
export async function extractUnitsFromText(
  text: string,
): Promise<ExtractedDocUnit[]> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const units: ExtractedDocUnit[] = [];
  for (const window of extractionWindows(text)) {
    units.push(...(await extractWindow(client, window)));
  }
  return mergeDocUnits(units);
}
