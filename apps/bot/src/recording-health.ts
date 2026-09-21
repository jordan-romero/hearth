// Is the recording actually recording?
//
// On 2026-09-16 capture died half an hour into a session and nothing said so: Discord kept
// reporting who was speaking, the bot stayed online, its icon sat in the voice channel — and no
// audio was saved for 27 minutes. It was found only by reading logs. This watches for exactly that
// and says so in the channel — once, and only when something is broken. The bot stays in the
// channel (leaving mid-scene is its own interruption), and a recovery is silent: the table is
// playing a game, and "everything is fine" is not worth a message.

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
  { kind: "voice-lost" } | { kind: "no-audio" } | { kind: "not-saving" };

export interface HealthCheck {
  /** Post this in the channel. Only ever a failure, and only the first one until it recovers. */
  alert: HealthAlert | null;
  /** Recording again after a warning: clear the warning so a later failure warns afresh. Nothing
   * is posted — the table doesn't need to hear that it's working. */
  recovered: boolean;
}

const QUIET: HealthCheck = { alert: null, recovered: false };

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

/** What, if anything, to tell the table now — and whether a warned-about failure has passed. */
export function checkHealth(h: RecordingHealth, now: number): HealthCheck {
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
    if (voiceLost) return { alert: { kind: "voice-lost" }, recovered: false };
    if (noAudio) return { alert: { kind: "no-audio" }, recovered: false };
    if (notSaving) return { alert: { kind: "not-saving" }, recovered: false };
    return QUIET;
  }
  const audioSinceWarning =
    h.lastAudioAtMs !== null && h.lastAudioAtMs > h.warnedAtMs;
  return audioSinceWarning && !notSaving && h.voiceDownSinceMs === null
    ? { alert: null, recovered: true }
    : QUIET;
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
  }
}
