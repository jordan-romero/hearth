// The Hearth worker — consumes async jobs (transcription, extraction) off the
// shared pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import {
  getQueue,
  getClip,
  transcribeClip,
  TRANSCRIBE_QUEUE,
  type TranscribeJob,
} from "@hearth/agents";
import { prisma } from "@hearth/db";

async function main(): Promise<void> {
  const boss = await getQueue();

  // clip → Deepgram → TranscriptSegment. The transcript for a session is later just
  // these segments ordered by startMs. A thrown handler lets pg-boss retry the job.
  await boss.work<TranscribeJob>(TRANSCRIBE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const {
        recordingId,
        audioClipId,
        storageKey,
        discordUserId,
        characterId,
        startMs,
        durationMs,
      } = job.data;

      const audio = await getClip(storageKey);
      const text = await transcribeClip(audio);
      if (!text) {
        console.log(`[transcribe] clip ${audioClipId}: (silence, skipped)`);
        continue;
      }

      // Upsert on the unique audioClipId so a retried job never double-writes.
      await prisma.transcriptSegment.upsert({
        where: { audioClipId },
        create: {
          recordingId,
          audioClipId,
          characterId,
          discordUserId,
          startMs,
          endMs: startMs + durationMs,
          text,
        },
        update: { text, endMs: startMs + durationMs },
      });

      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      console.log(`[transcribe] clip ${audioClipId}: "${preview}"`);
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
