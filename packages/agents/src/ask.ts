// ask() — the whole product in miniature: retrieve (filtered) → Claude answers
// from ONLY what the viewer may know. The filter runs before this, so the model
// is never handed a secret it could leak.

import Anthropic from "@anthropic-ai/sdk";
import type { Viewer } from "@hearth/core";
import { retrieveContext } from "./retrieve.js";

// Live Q&A runs on Haiku — it's grounded answer-from-context, not deep reasoning,
// and Haiku is ~3x cheaper (see the pricing model). Extraction stays on Sonnet.
const MODEL = "claude-haiku-4-5";

// Player view: answer as the character, strictly from what they may know. Retrieval has
// already stripped anything hidden from them, so the model can't leak — but it must not
// hint that hidden things exist either.
const SYSTEM_PLAYER = `You are the living memory of a Dungeons & Dragons campaign, answering a player as their character.
Use ONLY the knowledge entries and document excerpts provided in the user's message.
Rules:
- Everything provided to you IS what this character knows. The material has already been filtered to exactly what they are permitted to know, so if a piece is in front of you, the character knows it — report it plainly.
- This holds even when the text labels itself a "secret", says it is "hidden" or "guarded", or says "the party has not learned it". That wording describes the wider world, not this asker; the fact that it was provided means the character HAS learned it. Never refuse to state something, and never say the character doesn't know it, when it is present in the provided material.
- If the answer is genuinely not supported by what's provided, say the asker's character has no knowledge of it. Never speculate or draw on outside knowledge.
- NEVER imply that information exists but is hidden or withheld. If it isn't provided, then from the asker's perspective it simply is not known — answer as if that is the whole truth.
- Be concise and in-world. Note which entries or documents you drew on (by title) in parentheses.`;

// DM view: the asker OWNS all of this, including their private notes. Report everything.
const SYSTEM_DM = `You are the campaign memory, answering the DUNGEON MASTER — the author and owner of this campaign's material, private DM-only notes and secrets included.
Use ONLY the knowledge entries and document excerpts provided in the user's message.
Rules:
- Report everything the provided material contains, plainly and completely. The asker IS the DM, so DM-only notes and secrets are theirs to see — never withhold, redact, or hedge them. If a document is marked "DM only", that is exactly who is asking.
- If the answer is not supported by what's provided, say so plainly. Never speculate or draw on outside knowledge.
- Be concise. Note which entries or documents you drew on (by title) in parentheses.`;

export interface AskResult {
  answer: string;
  sources: { title: string; type: string }[];
}

export async function ask(
  viewer: Viewer,
  question: string,
): Promise<AskResult> {
  const { units, chunks } = await retrieveContext(viewer, question);

  const unitLines = units.map(
    (u, i) => `[U${i + 1}] ${u.title} (${u.type}): ${u.content}`,
  );
  const chunkLines = chunks.map(
    (c, i) => `[D${i + 1}] from "${c.docName}": ${c.text}`,
  );
  const sections: string[] = [];
  if (unitLines.length)
    sections.push(
      `Knowledge entries the asker may know:\n${unitLines.join("\n")}`,
    );
  if (chunkLines.length)
    sections.push(`Relevant document excerpts:\n${chunkLines.join("\n")}`);
  const context =
    sections.join("\n\n") ||
    "(no relevant knowledge is available to this character)";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: viewer.role === "DM" ? SYSTEM_DM : SYSTEM_PLAYER,
    messages: [
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ],
  });

  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    answer,
    sources: [
      ...units.map((u) => ({ title: u.title, type: u.type })),
      ...chunks.map((c) => ({ title: c.docName, type: "DOCUMENT" })),
    ],
  };
}
