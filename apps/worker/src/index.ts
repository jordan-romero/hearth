// The Hearth worker — consumes async jobs (transcription, extraction) off a
// pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import { PgBoss } from "pg-boss";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// pg-boss uses LISTEN/NOTIFY, which does NOT pass through pgbouncer's transaction
// pooler — so the worker connects on the DIRECT (5432) URL, not the pooled one.
const boss = new PgBoss(requireEnv("DIRECT_URL"));
boss.on("error", (err) => console.error("pg-boss error:", err));

/** Queue names (the bot's enqueue side will import these in Bite 2). */
export const TRANSCRIBE_QUEUE = "transcribe";

async function main(): Promise<void> {
  await boss.start();
  await boss.createQueue(TRANSCRIBE_QUEUE);

  // Bite 3 fills this in: pull the clip from Storage → Deepgram → TranscriptSegment.
  await boss.work(TRANSCRIBE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`[transcribe] job ${job.id}`, job.data);
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
