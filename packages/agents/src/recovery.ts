// A bot restart ends every recording it was holding, because live capture state only exists in
// the bot's memory. Without this, a recording cut off by a restart (a deploy mid-session) stays
// CAPTURING forever: its session never finalizes, so nothing it captured reaches the memory,
// and getActiveSession keeps reporting it as live.

import { prisma } from "@hearth/db";
import { scheduleFinalize } from "./queue.js";

/** When an interrupted recording ended: its last captured clip, or its start if it caught
 * nothing. */
export function interruptedEndedAt(
  startedAt: Date,
  lastClipAt: Date | null,
): Date {
  return lastClipAt && lastClipAt > startedAt ? lastClipAt : startedAt;
}

export interface RecoveredRecording {
  recordingId: string;
  gameSessionId: string;
}

/**
 * Close out recordings a restart cut off, the way /stop would, so their sessions finalize.
 *
 * Run once at bot startup. The session's activity is stamped now, so the usual gap window
 * applies: a DM who runs /record again soon after the restart resumes the same session, and
 * finalize still waits for any in-flight transcription before extracting.
 */
export async function recoverInterruptedRecordings(): Promise<
  RecoveredRecording[]
> {
  const stuck = await prisma.recording.findMany({
    where: { status: "CAPTURING" },
    select: {
      id: true,
      gameSessionId: true,
      startedAt: true,
      clips: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  const sessionIds = new Set<string>();
  for (const recording of stuck) {
    await prisma.recording.update({
      where: { id: recording.id },
      data: {
        status: "TRANSCRIBING",
        endedAt: interruptedEndedAt(
          recording.startedAt,
          recording.clips[0]?.createdAt ?? null,
        ),
      },
    });
    sessionIds.add(recording.gameSessionId);
  }

  for (const gameSessionId of sessionIds) {
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { lastActivityAt: new Date() },
    });
    await scheduleFinalize(gameSessionId);
  }

  return stuck.map((r) => ({
    recordingId: r.id,
    gameSessionId: r.gameSessionId,
  }));
}
