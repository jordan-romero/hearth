// The live session buffer — what's happening at the table RIGHT NOW.
//
// No new capture machinery is needed: /record already transcribes each speaking burst within
// seconds, all session long, so the recent transcript is simply a tail query over the active
// session's clips. That means "live" features (an NPC that fits the current scene, a
// what-did-I-miss recap) are reads, not a second pipeline. The trade-off is latency: the last
// few seconds aren't transcribed yet, so this is right for "the last few minutes" and wrong
// for word-by-word captions (that needs true streaming ASR — Phase 4b).

import { prisma } from "@hearth/db";

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
