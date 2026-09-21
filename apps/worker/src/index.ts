// The Hearth worker — consumes async jobs (transcription, extraction) off the
// shared pg-boss queue. Runs alongside the bot; deploys to Railway as its own service.

import {
  getQueue,
  getClip,
  transcribeClip,
  extractSession,
  decideAudience,
  narrowestAudience,
  buildGraph,
  writeRecapsForSession,
  sessionSource,
  embedTexts,
  toVectorLiteral,
  scheduleFinalize,
  getSpeakerLabels,
  speakerLabel,
  ingestDocument,
  TRANSCRIBE_QUEUE,
  FINALIZE_QUEUE,
  INGEST_QUEUE,
  SESSION_GAP_MS,
  type TranscribeJob,
  type FinalizeJob,
  type IngestJob,
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
        // The authoritative transcript for this audio has arrived, so drop the live segments
        // that stood in for it. Batch rescores with the whole clip in context and is better on
        // names, so the record should be this, not what streaming heard mid-sentence.
        await prisma.transcriptSegment.deleteMany({
          where: {
            recordingId,
            discordUserId,
            isLive: true,
            startMs: { gte: startMs },
            endMs: { lte: startMs + durationMs + 2000 },
          },
        });
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

      // Mark processed (text OR silence). Extraction no longer fires here — it happens
      // once per session at finalize, well after all clips are transcribed.
      await prisma.audioClip.update({
        where: { id: audioClipId },
        data: { transcribedAt: new Date() },
      });
    }
  });

  // A session whose quiet window elapsed → extract the WHOLE session + mark it complete.
  // If it actually resumed, the handler reschedules itself instead of finalizing.
  await boss.work<FinalizeJob>(FINALIZE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        await finalizeSession(job.data.gameSessionId);
      } catch (err) {
        // Nothing is lost — the transcript stays, and the session stays open — but no recap exists
        // until it's re-run, so say so plainly rather than leave a failed job to be found.
        console.error(
          `[finalize] session ${job.data.gameSessionId} could NOT be summarized; its transcript is ` +
            `intact and the session is still open. Re-run finalize for it once the cause is fixed.`,
          err,
        );
        throw err;
      }
    }
  });

  // A stored DM document → parsed → chunked → embedded (the RAG layer).
  await boss.work<IngestJob>(INGEST_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await ingestDocument(job.data.sourceDocumentId);
    }
  });

  console.log("🛠  Hearth worker online — waiting for jobs");
}

/** Finalize a game session: extract its FULL transcript (every recording — a session can span
 * several stop/restart segments) into a recap + knowledge units, then mark it complete.
 * Reschedules itself if the session resumed inside the gap window, so a break never finalizes
 * a session early. */
async function finalizeSession(gameSessionId: string): Promise<void> {
  const gameSession = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
    include: { recordings: { select: { id: true, status: true } } },
  });
  if (!gameSession) {
    console.warn(`[finalize] session ${gameSessionId} not found`);
    return;
  }
  if (gameSession.status === "COMPLETE") {
    console.log(`[finalize] session ${gameSessionId} already complete`);
    return;
  }
  // Still live (or resumed inside the window) → try again after another gap.
  const capturing = gameSession.recordings.some(
    (r) => r.status === "CAPTURING",
  );
  const quietFor = gameSession.lastActivityAt
    ? Date.now() - gameSession.lastActivityAt.getTime()
    : Infinity;
  if (capturing || quietFor < SESSION_GAP_MS) {
    console.log(
      `[finalize] session ${gameSessionId} still active — rescheduling`,
    );
    await scheduleFinalize(gameSessionId);
    return;
  }
  // Wait for transcription to drain before extracting, or we'd summarize a partial session.
  const pending = await prisma.audioClip.count({
    where: {
      recordingId: { in: gameSession.recordings.map((r) => r.id) },
      transcribedAt: null,
    },
  });
  if (pending > 0) {
    console.log(
      `[finalize] session ${gameSessionId}: ${pending} clip(s) still transcribing — rescheduling`,
    );
    await scheduleFinalize(gameSessionId);
    return;
  }

  // The whole session's speech, across every recording, in order. `startMs` is relative to
  // its OWN recording's start (each /record segment restarts at zero), so ordering by it alone
  // would interleave a resumed session's segments with the earlier ones. Order by the parent
  // recording first, then within it.
  const segments = await prisma.transcriptSegment.findMany({
    where: { recordingId: { in: gameSession.recordings.map((r) => r.id) } },
    orderBy: [{ recording: { startedAt: "asc" } }, { startMs: "asc" }],
    include: { character: { select: { name: true } } },
  });
  // The DM has no character, so without role-derived labels the narrator — most of the
  // session — would be attributed to "Unknown" in the transcript we hand to extraction.
  const labels = await getSpeakerLabels(gameSession.campaignId);
  if (segments.length === 0) {
    await finalize(gameSession.id);
    console.log(
      `[finalize] session ${gameSessionId}: no speech — nothing to extract`,
    );
    return;
  }

  const transcript = segments
    .map((s) => `${speakerLabel(s, labels)}: ${s.text}`)
    .join("\n");

  let granted = 0;
  const { recap, units } = await extractSession(transcript);

  // Who was actually at the table, and who can hand out knowledge on the campaign's behalf. A
  // session fact reaches the characters who learned it in the fiction — not everyone in the
  // campaign, as it used to — so both of these are needed before anything is stored.
  const [attendance, dm] = await Promise.all([
    prisma.sessionAttendance.findMany({
      where: { gameSessionId: gameSession.id, characterId: { not: null } },
      select: { character: { select: { id: true, name: true } } },
    }),
    prisma.membership.findFirst({
      where: { campaignId: gameSession.campaignId, role: "DM" },
      select: { id: true },
    }),
  ]);
  const present = attendance
    .map((a) => a.character)
    .filter((c): c is { id: string; name: string } => c !== null);

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
        // DM_ONLY plus a grant per character who learned it, rather than visible to the whole
        // campaign: a character who wasn't there hasn't learned what happened, and a secret told
        // to one character stays hers until she shares it.
        baseVisibility: "DM_ONLY" as const,
        title: u.title,
        content: u.content,
      })),
    });
    // Grants can only be attributed to a membership, and the campaign's DM is who the memory
    // acts for. Without one, the facts simply stay DM-only — never wider than intended.
    if (dm) {
      // Matched by title, not by position: lining up two lists by index would, if they ever drifted
      // apart, hand one character's private knowledge to another. Titles are the subject a fact was
      // merged under, so they are already distinct.
      const audiencesByTitle = new Map(
        units.map((u) => [u.title, u.audiences]),
      );
      const grants = rows.flatMap((row) =>
        narrowestAudience(
          (audiencesByTitle.get(row.title) ?? []).map((a) =>
            decideAudience(a, present),
          ),
        ).map((characterId) => ({
          knowledgeUnitId: row.id,
          characterId,
          revealedByMembershipId: dm.id,
        })),
      );
      if (grants.length > 0) {
        await tx.knowledgeGrant.createMany({
          data: grants,
          skipDuplicates: true,
        });
      }
      granted = grants.length;
    }
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

  // Add who and what came up at the table to the campaign graph — the same path uploads take, so a
  // campaign played in Hearth builds its graph as it goes. Never blocks finalizing the session.
  try {
    const graph = await buildGraph(gameSession.campaignId, [
      await sessionSource(gameSession.id),
    ]);
    console.log(
      `[finalize] session ${gameSessionId}: graph entities=${graph.entitiesTotal} ` +
        `relations=${graph.relations} failedWindows=${graph.failedWindows}`,
    );
  } catch (err) {
    console.error(`[finalize] graph build failed for ${gameSessionId}:`, err);
  }

  // Each character's own recap — what they were there for, nothing told privately to someone else —
  // plus the same in their voice. Never blocks finalizing: without it, players see the table recap.
  try {
    const recaps = await writeRecapsForSession(gameSession.id);
    console.log(
      `[finalize] session ${gameSessionId}: character recaps written=${recaps.written} ` +
        `of ${recaps.characters}, failed=${recaps.failed}`,
    );
  } catch (err) {
    console.error(
      `[finalize] character recaps failed for ${gameSessionId}:`,
      err,
    );
  }

  await finalize(gameSession.id);
  console.log(
    `[finalize] session ${gameSessionId}: recap + ${created.length} knowledge units stored, ` +
      `${granted} grant(s) to the ${present.length} character(s) who were there`,
  );
}

/** Mark a session — and all of its recordings — fully processed. */
async function finalize(gameSessionId: string): Promise<void> {
  await prisma.recording.updateMany({
    where: { gameSessionId, status: { not: "FAILED" } },
    data: { status: "DONE" },
  });
  await prisma.gameSession.update({
    where: { id: gameSessionId },
    data: { status: "COMPLETE" },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
