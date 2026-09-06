// Session capture — the spike logic made real: join the VC, capture each speaker's
// speaking burst separately (no stitching), decode it to a WAV clip, store it, write
// an AudioClip row, and enqueue a transcription job. The transcript is later just
// these clips' text ordered by startMs.
//
// Why WAV and not a compressed container: the worker re-encodes clips to Opus for
// permanent storage, so the bot's format is transient. Deepgram bills by duration,
// not bytes, so WAV costs the same to transcribe — and decoding with opusscript is
// pure-JS, which keeps the bot free of native addons that fight every deploy.

import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { opus } from "prism-media";
import { prisma } from "@hearth/db";
import {
  getQueue,
  putClip,
  scheduleFinalize,
  TRANSCRIBE_QUEUE,
  SESSION_GAP_MS,
  type TranscribeJob,
} from "@hearth/agents";

interface ActiveRecording {
  recordingId: string;
  gameSessionId: string;
  startedAtMs: number;
  speakerMap: Map<string, string>; // discordUserId → characterId
  capturing: Set<string>;
}

const active = new Map<string, ActiveRecording>(); // guildId → recording
// Guilds whose /record is mid-setup. `active` isn't populated until after several awaits, so
// without this a second /record slips through the "already recording?" check and creates a
// second CAPTURING recording — and only one can live in `active`, leaving the other unstoppable
// and blocking finalize forever.
const starting = new Set<string>();

/** The merge window in words, derived from the real value so the message can't drift from the
 * behaviour (HEARTH_SESSION_GAP_MIN can shorten it to seconds for testing). */
function formatGap(): string {
  const minutes = SESSION_GAP_MS / 60_000;
  if (minutes < 1) return `${Math.round(SESSION_GAP_MS / 1000)} sec`;
  return `${Math.round(minutes)} min`;
}

const SAMPLE_RATE = 48000; // Discord voice is always 48kHz
const DECODE_CHANNELS = 2; // Discord's Opus decodes to stereo…
const OUTPUT_CHANNELS = 1; // …but each clip is one speaker, so store mono (half the bytes)
const BIT_DEPTH = 16;

/** Downmix interleaved stereo s16le to mono by averaging the two channels. */
function stereoToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4); // 2 channels × 2 bytes/sample
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}

/** Wrap raw mono PCM (s16le) in a 44-byte WAV header so Deepgram reads it directly. */
function wavFromPcm(pcm: Buffer): Buffer {
  const byteRate = SAMPLE_RATE * OUTPUT_CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = OUTPUT_CHANNELS * (BIT_DEPTH / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(OUTPUT_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** discordUserId → characterId for everyone linked in this campaign. */
async function loadSpeakerMap(
  campaignId: string,
): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({
    where: { discordUserId: { not: null } },
    include: {
      memberships: {
        where: { campaignId },
        include: { characters: { where: { campaignId }, take: 1 } },
      },
    },
  });
  const map = new Map<string, string>();
  for (const u of users) {
    const character = u.memberships[0]?.characters[0];
    if (u.discordUserId && character) map.set(u.discordUserId, character.id);
  }
  return map;
}

export async function startRecording(
  interaction: ChatInputCommandInteraction,
  campaignId: string,
): Promise<void> {
  const guildId = interaction.guildId;
  const channel = (interaction.member as GuildMember).voice.channel;
  if (!guildId || !channel) {
    await interaction.reply({
      content: "Join a voice channel first, then `/record`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (active.has(guildId) || starting.has(guildId)) {
    await interaction.reply({
      content: "Already recording.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Reserve the guild synchronously, before the first await, so a concurrent /record can't
  // race past the check above. Released once `active` owns it, or on any failure below.
  starting.add(guildId);
  try {
    await startRecordingInner(interaction, campaignId, guildId, channel);
  } finally {
    starting.delete(guildId);
  }
}

async function startRecordingInner(
  interaction: ChatInputCommandInteraction,
  campaignId: string,
  guildId: string,
  channel: NonNullable<GuildMember["voice"]["channel"]>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Find-or-create the session. A /record within the merge window RESUMES the most recent
  // still-open session — a break/stop/restart is the SAME session, and just adds another
  // Recording to it — rather than spawning a new session and bumping the session number.
  // SESSION_GAP_MS is shared with the finalize delay, so "resumable" and "finalizable"
  // can never disagree about how long a break may be.
  const open = await prisma.gameSession.findFirst({
    where: {
      campaignId,
      status: { not: "COMPLETE" },
      lastActivityAt: { gte: new Date(Date.now() - SESSION_GAP_MS) },
    },
    orderBy: { lastActivityAt: "desc" },
  });
  const resumed = open !== null;
  const gameSession = open
    ? await prisma.gameSession.update({
        where: { id: open.id },
        data: { status: "ACTIVE", lastActivityAt: new Date() },
      })
    : await prisma.gameSession.create({
        data: {
          campaignId,
          number:
            ((
              await prisma.gameSession.findFirst({
                where: { campaignId },
                orderBy: { number: "desc" },
              })
            )?.number ?? 0) + 1,
          status: "ACTIVE",
          occurredAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
  // Each /record segment is its own Recording under the (possibly resumed) session.
  const recording = await prisma.recording.create({
    data: { gameSessionId: gameSession.id, status: "CAPTURING" },
  });

  const state: ActiveRecording = {
    recordingId: recording.id,
    gameSessionId: gameSession.id,
    startedAtMs: Date.now(),
    speakerMap: await loadSpeakerMap(campaignId),
    capturing: new Set(),
  };
  active.set(guildId, state);

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive
      selfMute: true,
    });
    // Voice-connection lifecycle — low-frequency, and the first thing to check if
    // capture ever goes quiet (does it reach Ready and stay, or drop/reconnect?).
    connection.on("stateChange", (oldState, newState) => {
      console.log(`🔊 voice: ${oldState.status} → ${newState.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    connection.receiver.speaking.on("start", (userId) => {
      void captureBurst(connection.receiver, userId, state);
    });

    console.log(
      `🔴 ${resumed ? "resumed" : "started"} — session ${gameSession.number} in "${channel.name}"`,
    );
    await interaction.editReply(
      `🔴 ${resumed ? "Resumed" : "Recording"} session ${gameSession.number} in **${channel.name}** — play on, then \`/stop\`.`,
    );
  } catch (err) {
    // If joining/awaiting the voice connection fails, undo everything — otherwise the
    // guild stays "Already recording", the connection leaks, and the recording is
    // orphaned in CAPTURING forever.
    console.error("startRecording: voice connection failed:", err);
    getVoiceConnection(guildId)?.destroy();
    active.delete(guildId);
    await prisma.recording.update({
      where: { id: recording.id },
      data: { status: "FAILED", endedAt: new Date() },
    });
    await interaction
      .editReply("Couldn't join your voice channel — try `/record` again.")
      .catch(() => {});
  }
}

/** Capture one speaking burst → mono WAV clip → store → AudioClip → enqueue. */
async function captureBurst(
  receiver: import("@discordjs/voice").VoiceReceiver,
  userId: string,
  state: ActiveRecording,
): Promise<void> {
  if (state.capturing.has(userId)) return;
  state.capturing.add(userId);
  const startMs = Date.now() - state.startedAtMs;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
  });
  const decoder = new opus.Decoder({
    rate: SAMPLE_RATE,
    channels: DECODE_CHANNELS,
    frameSize: 960,
  });

  const chunks: Buffer[] = [];
  const pcm = opusStream.pipe(decoder);
  pcm.on("data", (c: Buffer) => chunks.push(c));

  await new Promise<void>((resolve) => {
    pcm.on("end", () => resolve());
    pcm.on("error", (e: unknown) => {
      console.error("capture decode error:", e);
      resolve();
    });
  });
  state.capturing.delete(userId);

  const pcmData = Buffer.concat(chunks);
  if (pcmData.length === 0) {
    // Speaking fired but nothing decoded — worth a warning (empty/undecodable audio).
    console.warn(`⚠️  burst from ${userId} decoded to 0 bytes — dropped`);
    return;
  }
  const data = wavFromPcm(stereoToMono(pcmData));
  const durationMs = Date.now() - state.startedAtMs - startMs;
  const characterId = state.speakerMap.get(userId) ?? null;

  try {
    const clip = await prisma.audioClip.create({
      data: {
        recordingId: state.recordingId,
        characterId,
        discordUserId: userId,
        storagePath: "", // set after upload
        startMs,
        durationMs,
        codec: "pcm_s16le",
      },
    });
    const key = `${state.recordingId}/${clip.id}.wav`;
    await putClip(key, data);
    await prisma.audioClip.update({
      where: { id: clip.id },
      data: { storagePath: key },
    });

    // Attendance: they spoke, so they were here.
    await prisma.sessionAttendance.upsert({
      where: {
        gameSessionId_discordUserId: {
          gameSessionId: state.gameSessionId,
          discordUserId: userId,
        },
      },
      create: {
        gameSessionId: state.gameSessionId,
        characterId,
        discordUserId: userId,
      },
      update: {},
    });

    const boss = await getQueue();
    const job: TranscribeJob = {
      recordingId: state.recordingId,
      audioClipId: clip.id,
      storageKey: key,
      discordUserId: userId,
      characterId,
      startMs,
      durationMs,
    };
    await boss.send(TRANSCRIBE_QUEUE, job);
    console.log(`💾 clip ${clip.id} (${durationMs}ms) from ${userId} → queued`);
  } catch (err) {
    console.error("captureBurst failed:", err);
  }
}

export async function stopRecording(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  const state = guildId ? active.get(guildId) : undefined;
  if (!guildId || !state) {
    await interaction.reply({
      content: "Not recording.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  getVoiceConnection(guildId)?.destroy();
  active.delete(guildId);
  await prisma.recording.update({
    where: { id: state.recordingId },
    data: { status: "TRANSCRIBING", endedAt: new Date() },
  });
  const clipCount = await prisma.audioClip.count({
    where: { recordingId: state.recordingId },
  });
  console.log(
    `⏹ recording stopped — ${clipCount} clip(s) captured (recording ${state.recordingId})`,
  );
  // The session stays OPEN — a /record within the gap window resumes it (breaks shouldn't
  // split a session). Stamp the activity and schedule a delayed finalize; if we resume, the
  // finalize job reschedules itself rather than summarizing a half-finished session.
  await prisma.gameSession.update({
    where: { id: state.gameSessionId },
    data: { lastActivityAt: new Date() },
  });
  await scheduleFinalize(state.gameSessionId);
  await interaction.reply({
    content: `⏹ Stopped — transcribing. \`/record\` again within ${formatGap()} and it stays the same session.`,
    flags: MessageFlags.Ephemeral,
  });
}
