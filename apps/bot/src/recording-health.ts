// Is the recording actually recording?
//
// On 2026-09-16 capture died half an hour into a session and nothing said so: Discord kept
// reporting who was speaking, the bot stayed online, its icon sat in the voice channel — and no
// audio was saved for 27 minutes. It was found only by reading logs. This watches for exactly that
// and says so in the channel, once, so anyone at the table can fix it (/stop, /record) — and says
// so again when it recovers.

/** People have been talking this recently… */
export const SPEAKING_RECENT_MS = 60_000;
/** …but no audio has been decoded for this long. Longer than a pause, far shorter than a scene. */
export const NO_AUDIO_MS = 120_000;
/** Clips that failed to save in a row before it's worth interrupting the table. */
export const SAVE_FAILURES_TO_WARN = 3;
/** How long the voice connection may be down before it's more than a reconnect blip. */
export const VOICE_DOWN_MS = 30_000;

export interface RecordingHealth {
  startedAtMs: number;
  lastSpeakingAtMs: number | null;
  /** Last time any audio was decoded — updated as it streams, not only when a clip is saved, so a
   * long speech doesn't look like a failure. */
  lastAudioAtMs: number | null;
  /** Clip saves that failed since the last one that succeeded. */
  consecutiveSaveFailures: number;
  /** When the voice connection left "ready", if it hasn't come back. */
  voiceDownSinceMs: number | null;
  warnedAtMs: number | null;
}

export type HealthAlert =
  | { kind: "voice-lost" }
  | { kind: "no-audio" }
  | { kind: "not-saving" }
  | { kind: "recovered" };

export function newHealth(now: number): RecordingHealth {
  return {
    startedAtMs: now,
    lastSpeakingAtMs: null,
    lastAudioAtMs: null,
    consecutiveSaveFailures: 0,
    voiceDownSinceMs: null,
    warnedAtMs: null,
  };
}

/** What, if anything, to tell the table now. Warns at most once until recording recovers. */
export function checkHealth(
  h: RecordingHealth,
  now: number,
): HealthAlert | null {
  const lastAudio = h.lastAudioAtMs ?? h.startedAtMs;
  const talking =
    h.lastSpeakingAtMs !== null &&
    now - h.lastSpeakingAtMs <= SPEAKING_RECENT_MS;
  const noAudio =
    talking &&
    now - lastAudio >= NO_AUDIO_MS &&
    h.lastSpeakingAtMs! > lastAudio;
  const notSaving = h.consecutiveSaveFailures >= SAVE_FAILURES_TO_WARN;

  const voiceLost =
    h.voiceDownSinceMs !== null && now - h.voiceDownSinceMs >= VOICE_DOWN_MS;

  if (h.warnedAtMs === null) {
    if (voiceLost) return { kind: "voice-lost" };
    if (noAudio) return { kind: "no-audio" };
    if (notSaving) return { kind: "not-saving" };
    return null;
  }
  const audioSinceWarning =
    h.lastAudioAtMs !== null && h.lastAudioAtMs > h.warnedAtMs;
  return audioSinceWarning && !notSaving && h.voiceDownSinceMs === null
    ? { kind: "recovered" }
    : null;
}

export function alertText(alert: HealthAlert): string {
  switch (alert.kind) {
    case "voice-lost":
      return (
        "⚠️ **Hearth has dropped out of the voice channel and isn't recording.** " +
        "Anyone can fix it: run `/stop`, then `/record` — it picks up the same session."
      );
    case "no-audio":
      return (
        "⚠️ **Hearth can hear people talking but hasn't recorded any audio for 2 minutes.** " +
        "Anyone can fix it: run `/stop`, then `/record` — it picks up the same session."
      );
    case "not-saving":
      return (
        "⚠️ **Hearth is hearing the table but can't save what it records.** " +
        "Try `/stop`, then `/record`. If this keeps happening, tell whoever runs Hearth."
      );
    case "recovered":
      return "✅ Recording is working again.";
  }
}
