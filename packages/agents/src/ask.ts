// ask() — the whole product in miniature: retrieve (filtered) → Claude answers
// from ONLY what the viewer may know. The filter runs before this, so the model
// is never handed a secret it could leak.

import Anthropic from "@anthropic-ai/sdk";
import type { Viewer } from "@hearth/core";
import { retrieveForViewer, type RetrievedUnit } from "./retrieve.js";

// Live Q&A runs on Haiku — it's grounded answer-from-context, not deep reasoning,
// and Haiku is ~3x cheaper (see the pricing model). Extraction stays on Sonnet.
const MODEL = "claude-haiku-4-5";

const SYSTEM = `You are the living memory of a Dungeons & Dragons campaign, answering a member of the table.
Use ONLY the knowledge entries provided in the user's message.
Rules:
- If the answer is not supported by those entries, say the asker's character has no knowledge of it. Never speculate or draw on outside knowledge.
- If an entry states something plainly — even a secret or a hidden truth — report it as fact to this asker. Do not hedge or call it uncertain when an entry settles it.
- NEVER imply that information exists but is hidden or withheld. If it isn't in the entries, then from the asker's perspective it simply is not known — answer as if that is the whole truth.
- Be concise and in-world. Note which entries you drew on by their title in parentheses.`;

export interface AskResult {
  answer: string;
  sources: { title: string; type: string }[];
}

export async function ask(
  viewer: Viewer,
  question: string,
): Promise<AskResult> {
  const units: RetrievedUnit[] = await retrieveForViewer(viewer, question);

  const context = units.length
    ? units
        .map((u, i) => `[${i + 1}] ${u.title} (${u.type}): ${u.content}`)
        .join("\n")
    : "(no relevant knowledge is available to this character)";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Knowledge entries the asker may know:\n${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    answer,
    sources: units.map((u) => ({ title: u.title, type: u.type })),
  };
}
