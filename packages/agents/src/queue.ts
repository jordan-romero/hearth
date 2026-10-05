// Shared pg-boss access — the bot and web enqueue, the worker consumes, all through this one
// helper so they agree on connection + queue setup.
// pg-boss uses LISTEN/NOTIFY, so it connects on the DIRECT URL (the session pooler), whose
// connections are few (Supabase: 15) and shared by every service.
//
// Two shapes:
//   full     (worker, bot — long-running): supervision, cron, queue setup.
//   producer (web on Vercel — many short-lived instances): ONE connection, no supervision, no
//            cron, no migrations, no queue setup. It only sends. Each serverless instance running
//            a full pg-boss opened several session connections and ran its own maintenance, which
//            exhausted the pool and made page saves fail.

import { PgBoss } from "pg-boss";
import {
  TRANSCRIBE_QUEUE,
  FINALIZE_QUEUE,
  INGEST_QUEUE,
  PAGE_INDEX_QUEUE,
  ONENOTE_IMPORT_QUEUE,
  SESSION_GAP_SEC,
  type FinalizeJob,
} from "./jobs.js";

type QueueRole = "full" | "producer";

/** Producer on Vercel unless told otherwise (HEARTH_QUEUE_ROLE=full|producer). */
export function queueRole(): QueueRole {
  const explicit = process.env.HEARTH_QUEUE_ROLE;
  if (explicit === "full" || explicit === "producer") return explicit;
  return process.env.VERCEL ? "producer" : "full";
}

// The start in progress, not just its result: two callers arriving together share one instance
// instead of each starting their own.
let starting: Promise<PgBoss> | undefined;

export function getQueue(): Promise<PgBoss> {
  starting ??= start().catch((err) => {
    starting = undefined; // let the next caller try again
    throw err;
  });
  return starting;
}

async function start(): Promise<PgBoss> {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not set");

  if (queueRole() === "producer") {
    const producer = new PgBoss({
      connectionString: url,
      max: 1,
      application_name: "hearth-web",
      supervise: false,
      schedule: false,
      migrate: false,
      createSchema: false,
    });
    producer.on("error", (err) =>
      console.error("pg-boss (producer) error:", err),
    );
    await producer.start();
    return producer; // queues are created by the worker
  }

  const instance = new PgBoss(url);
  instance.on("error", (err) => console.error("pg-boss error:", err));
  await instance.start();
  await instance.createQueue(TRANSCRIBE_QUEUE); // idempotent
  // `stately` = at most one finalize job per singletonKey (gameSessionId) per state, so a
  // burst of /stops (across a merged session) can't pile up duplicate finalizations.
  await instance.createQueue(FINALIZE_QUEUE, { policy: "stately" });
  await instance.createQueue(INGEST_QUEUE);
  // `stately`: one waiting index job per page (singletonKey), so a burst of autosaves is one job.
  await instance.createQueue(PAGE_INDEX_QUEUE, { policy: "stately" });
  await instance.createQueue(ONENOTE_IMPORT_QUEUE);
  return instance;
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
