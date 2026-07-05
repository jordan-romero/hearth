// The Hearth worker — consumes async jobs (transcription, extraction) off the
// shared pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import { PgBoss } from "pg-boss";
import {
  getQueue,
  getClip,
  transcribeClip,
  TRANSCRIBE_QUEUE,
  EXTRACT_QUEUE,
  type TranscribeJob,
  type ExtractJob,
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

      if (text) {
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
      } else {
        console.log(`[transcribe] clip ${audioClipId}: (silence, skipped)`);
      }

      // Mark processed (text OR silence) so completion can be detected, then fire
      // extraction the moment the recording's last clip lands.
      await prisma.audioClip.update({
        where: { id: audioClipId },
        data: { transcribedAt: new Date() },
      });
      await maybeEnqueueExtract(boss, recordingId);
    }
  });

  // A fully-transcribed recording → campaign memory. Stubbed for Bite 4a.
  await boss.work<ExtractJob>(EXTRACT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { recordingId } = job.data;
      const segments = await prisma.transcriptSegment.count({
        where: { recordingId },
      });
      // Bite 4b fills this in: transcript → Claude → recap + SESSION knowledge units.
      console.log(
        `[extract] recording ${recordingId} ready — ${segments} segments`,
      );
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

/** Enqueue extraction once every clip in the recording has been processed.
 * singletonKey = recordingId dedupes the race when several clips finish together. */
async function maybeEnqueueExtract(
  boss: PgBoss,
  recordingId: string,
): Promise<void> {
  const pending = await prisma.audioClip.count({
    where: { recordingId, transcribedAt: null },
  });
  if (pending > 0) return;
  const job: ExtractJob = { recordingId };
  await boss.send(EXTRACT_QUEUE, job, { singletonKey: recordingId });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
