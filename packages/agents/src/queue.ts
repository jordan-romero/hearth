// Shared pg-boss access — the bot enqueues, the worker consumes, both through
// this one helper so they agree on connection + queue setup.
// pg-boss uses LISTEN/NOTIFY, so it connects on the DIRECT URL (not the pooler).

import { PgBoss } from "pg-boss";
import { prisma } from "@hearth/db";
import { TRANSCRIBE_QUEUE, EXTRACT_QUEUE, type ExtractJob } from "./jobs.js";

let boss: PgBoss | undefined;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const instance = new PgBoss(url);
  instance.on("error", (err) => console.error("pg-boss error:", err));
  await instance.start();
  await instance.createQueue(TRANSCRIBE_QUEUE); // idempotent
  // `stately` = at most one extract job per singletonKey (recordingId) per state, so
  // the completion race can't enqueue (or run) duplicate extractions for a recording.
  await instance.createQueue(EXTRACT_QUEUE, { policy: "stately" });
  boss = instance;
  return boss;
}

/**
 * Enqueue extraction for a recording IFF it has stopped (`TRANSCRIBING`) and every
 * clip is transcribed. The status gate is essential: while a recording is still
 * `CAPTURING`, the pending-clip count momentarily hits zero between speaking bursts —
 * without this check that would fire extraction mid-session and mark it done early.
 *
 * Called from both trigger points — the worker (after each clip transcribes) and the
 * bot (right after `/stop`, since the last clip may already be done). singletonKey +
 * the `stately` queue policy dedupe the two paths.
 */
export async function maybeEnqueueExtraction(
  recordingId: string,
): Promise<void> {
  const rec = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: { status: true },
  });
  if (rec?.status !== "TRANSCRIBING") return; // still capturing, or already done
  const pending = await prisma.audioClip.count({
    where: { recordingId, transcribedAt: null },
  });
  if (pending > 0) return;

  const job: ExtractJob = { recordingId };
  await (
    await getQueue()
  ).send(EXTRACT_QUEUE, job, {
    singletonKey: recordingId,
  });
}
