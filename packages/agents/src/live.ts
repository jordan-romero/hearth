// The live session buffer — what's happening at the table RIGHT NOW.
//
// No new capture machinery is needed: /record already transcribes each speaking burst within
// seconds, all session long, so the recent transcript is simply a tail query over the active
// session's clips. That means "live" features (an NPC that fits the current scene, a
// what-did-I-miss recap) are reads, not a second pipeline. The trade-off is latency: the last
// few seconds aren't transcribed yet, so this is right for "the last few minutes" and wrong
// for word-by-word captions (that needs true streaming ASR — Phase 4b).

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@hearth/db";

// Catch-up summaries run on Haiku — short, grounded, and asked repeatedly during a session,
// so the cheap model is the right call (extraction still uses Sonnet).
const RECAP_MODEL = "claude-haiku-4-5";

export interface LiveSession {
  gameSessionId: string;
  number: number;
  startedAt: Date;
}

/** The campaign's session that is currently being recorded, if any. */
export async function getActiveSession(
  campaignId: string,
): Promise<LiveSession | null> {
  const session = await prisma.gameSession.findFirst({
    where: {
      campaignId,
      status: "ACTIVE",
      recordings: { some: { status: "CAPTURING" } },
    },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true, number: true, createdAt: true, occurredAt: true },
  });
  if (!session) return null;
  return {
    gameSessionId: session.id,
    number: session.number,
    startedAt: session.occurredAt ?? session.createdAt,
  };
}

/** Speaker-labeled transcript of the last `minutes` of a session, oldest-first. Spans every
 * recording in the session, so a mid-session break doesn't hide what came before it. */
export async function getLiveTranscript(
  gameSessionId: string,
  minutes = 10,
): Promise<string> {
  const since = new Date(Date.now() - minutes * 60_000);
  const segments = await prisma.transcriptSegment.findMany({
    where: {
      recording: { gameSessionId },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
    select: {
      text: true,
      character: { select: { name: true } },
    },
  });
  return segments
    .map((s) => `${s.character?.name ?? "Unknown"}: ${s.text}`)
    .join("\n");
}

const CATCH_UP_SYSTEM = `You are catching a player up on the tabletop RPG session they are sitting in, after they stepped away for a few minutes.

You are given a rough live transcript of what was just said at the table. It is speech-to-text, so expect mistakes, half-sentences, and crosstalk, and it mixes in-fiction play with out-of-character table talk (dice, rules arguments, snacks, scheduling).

Write a short catch-up: a few sentences, or up to four bullets if several distinct things happened. Cover only what happened IN THE STORY — skip the table talk entirely. Past tense, plain and concrete, no preamble like "here's what you missed". If the transcript is too garbled or nothing of substance happened in the fiction, say so in one sentence rather than inventing events.

Everything here was said out loud at the table, so nothing is a secret — but never speculate beyond what the transcript supports.`;

/** Summarize what just happened at the table, for someone who stepped away. Table-audible
 * speech only, so there's nothing to permission-filter — everyone present heard it. */
export async function summarizeRecent(transcript: string): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({
    model: RECAP_MODEL,
    max_tokens: 500,
    system: CATCH_UP_SYSTEM,
    messages: [{ role: "user", content: `Live transcript:\n\n${transcript}` }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
