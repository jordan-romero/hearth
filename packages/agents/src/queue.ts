// Shared pg-boss access — the bot enqueues, the worker consumes, both through
// this one helper so they agree on connection + queue setup.
// pg-boss uses LISTEN/NOTIFY, so it connects on the DIRECT URL (not the pooler).

import { PgBoss } from "pg-boss";
import {
  TRANSCRIBE_QUEUE,
  FINALIZE_QUEUE,
  INGEST_QUEUE,
  SESSION_GAP_SEC,
  type FinalizeJob,
} from "./jobs.js";

let boss: PgBoss | undefined;

export async function getQueue(): Promise<PgBoss> {
  if (boss) return boss;
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  const instance = new PgBoss(url);
  instance.on("error", (err) => console.error("pg-boss error:", err));
  await instance.start();
  await instance.createQueue(TRANSCRIBE_QUEUE); // idempotent
  // `stately` = at most one finalize job per singletonKey (gameSessionId) per state, so a
  // burst of /stops (across a merged session) can't pile up duplicate finalizations.
  await instance.createQueue(FINALIZE_QUEUE, { policy: "stately" });
  await instance.createQueue(INGEST_QUEUE);
  boss = instance;
  return boss;
}

/**
 * Schedule finalization for a session, delayed by the gap window. If the session resumes
 * (another /record) before the job fires, the worker's finalize handler sees the fresh
 * lastActivityAt and reschedules instead of finalizing — so a break never finalizes early.
 * singletonKey dedupes the schedules from each /stop of a merged session.
 */
export async function scheduleFinalize(gameSessionId: string): Promise<void> {
  const job: FinalizeJob = { gameSessionId };
  await (
    await getQueue()
  ).send(FINALIZE_QUEUE, job, {
    startAfter: SESSION_GAP_SEC,
    singletonKey: gameSessionId,
  });
}
