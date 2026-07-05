// The Hearth worker — consumes async jobs (transcription, extraction) off the
// shared pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import { PgBoss } from "pg-boss";
import {
  getQueue,
  getClip,
  transcribeClip,
  extractSession,
  embedTexts,
  toVectorLiteral,
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

  // A fully-transcribed recording → campaign memory (recap + knowledge units).
  await boss.work<ExtractJob>(EXTRACT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await runExtraction(job.data.recordingId);
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

/** Distill a session's transcript into a recap + embedded SESSION knowledge units. */
async function runExtraction(recordingId: string): Promise<void> {
  const rec = await prisma.recording.findUnique({
    where: { id: recordingId },
    include: { gameSession: true },
  });
  if (!rec) {
    console.warn(`[extract] recording ${recordingId} not found`);
    return;
  }
  if (rec.status === "DONE") {
    console.log(
      `[extract] recording ${recordingId} already extracted — skipping`,
    );
    return;
  }
  const { gameSession } = rec;

  const segments = await prisma.transcriptSegment.findMany({
    where: { recordingId },
    orderBy: { startMs: "asc" },
    include: { character: { select: { name: true } } },
  });
  if (segments.length === 0) {
    await finalize(recordingId, gameSession.id);
    console.log(
      `[extract] recording ${recordingId}: no speech — nothing to extract`,
    );
    return;
  }

  const transcript = segments
    .map((s) => `${s.character?.name ?? "Unknown"}: ${s.text}`)
    .join("\n");

  const { recap, units } = await extractSession(transcript);

  // Replace this session's SESSION units atomically, so a retried job can't duplicate
  // them. createManyAndReturn gives back the ids we need to attach embeddings.
  const created = await prisma.$transaction(async (tx) => {
    await tx.knowledgeUnit.deleteMany({
      where: { gameSessionId: gameSession.id, source: "SESSION" },
    });
    const rows = await tx.knowledgeUnit.createManyAndReturn({
      data: units.map((u) => ({
        campaignId: gameSession.campaignId,
        gameSessionId: gameSession.id,
        type: u.type,
        source: "SESSION" as const,
        origin: "PLAYED" as const,
        baseVisibility: "EVERYONE" as const,
        title: u.title,
        content: u.content,
      })),
    });
    await tx.gameSession.update({
      where: { id: gameSession.id },
      data: { recap },
    });
    return rows;
  });

  // Embed the new units so /ask can retrieve them (same pattern as the seed).
  if (created.length > 0) {
    const vectors = await embedTexts(
      created.map((u) => `${u.title}. ${u.content}`),
      "document",
    );
    for (let i = 0; i < created.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      await prisma.$executeRaw`UPDATE "KnowledgeUnit" SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${created[i]!.id}`;
    }
  }

  await finalize(recordingId, gameSession.id);
  console.log(
    `[extract] recording ${recordingId}: recap + ${created.length} knowledge units stored`,
  );
}

/** Mark a recording (and its session) fully processed. */
async function finalize(
  recordingId: string,
  gameSessionId: string,
): Promise<void> {
  await prisma.recording.update({
    where: { id: recordingId },
    data: { status: "DONE" },
  });
  await prisma.gameSession.update({
    where: { id: gameSessionId },
    data: { status: "COMPLETE" },
  });
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
