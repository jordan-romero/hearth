// The Hearth worker — consumes async jobs (transcription, extraction) off the
// shared pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import { getQueue, TRANSCRIBE_QUEUE, type TranscribeJob } from "@hearth/agents";

async function main(): Promise<void> {
  const boss = await getQueue();

  // Bite 3 fills this in: getClip(storageKey) → Deepgram → TranscriptSegment.
  await boss.work<TranscribeJob>(TRANSCRIBE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { audioClipId, discordUserId, durationMs } = job.data;
      console.log(
        `[transcribe] clip ${audioClipId} from ${discordUserId} (${durationMs}ms)`,
      );
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
