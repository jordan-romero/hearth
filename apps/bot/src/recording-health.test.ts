import { describe, it, expect } from "vitest";
import {
  checkHealth,
  newHealth,
  NO_AUDIO_MS,
  SAVE_FAILURES_TO_WARN,
  VOICE_DOWN_MS,
} from "./recording-health.js";

const t0 = 1_000_000;
const min = 60_000;

describe("checkHealth", () => {
  it("stays quiet while audio is flowing", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 5 * min,
      lastAudioAtMs: t0 + 5 * min - 1000,
    };
    expect(checkHealth(h, t0 + 5 * min + 10_000)).toBeNull();
  });

  it("warns when people are talking but no audio has come through — last night's failure", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 10 * min,
      lastAudioAtMs: t0 + 1 * min,
    };
    expect(checkHealth(h, t0 + 10 * min + 5_000)).toEqual({ kind: "no-audio" });
  });

  it("doesn't warn when nobody is talking (a break, or everyone muted)", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 1 * min,
      lastAudioAtMs: t0 + 1 * min,
    };
    expect(checkHealth(h, t0 + 30 * min)).toBeNull();
  });

  it("doesn't warn before the gap is long enough", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 90_000,
      lastAudioAtMs: null,
    };
    expect(checkHealth(h, t0 + NO_AUDIO_MS - 1)).toBeNull();
  });

  it("warns when clips keep failing to save", () => {
    const h = {
      ...newHealth(t0),
      consecutiveSaveFailures: SAVE_FAILURES_TO_WARN,
    };
    expect(checkHealth(h, t0 + min)).toEqual({ kind: "not-saving" });
  });

  it("warns once, not every check", () => {
    const warned = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 10 * min,
      lastAudioAtMs: t0,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(warned, t0 + 11 * min)).toBeNull();
  });

  it("says so when audio comes back after a warning", () => {
    const back = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 12 * min,
      lastAudioAtMs: t0 + 12 * min,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(back, t0 + 12 * min + 1000)).toEqual({
      kind: "recovered",
    });
  });

  it("warns when the voice connection stays down, not for a reconnect blip", () => {
    const down = { ...newHealth(t0), voiceDownSinceMs: t0 + min };
    expect(checkHealth(down, t0 + min + 5_000)).toBeNull();
    expect(checkHealth(down, t0 + min + VOICE_DOWN_MS)).toEqual({
      kind: "voice-lost",
    });
  });

  it("doesn't call it recovered while the connection is still down", () => {
    const h = {
      ...newHealth(t0),
      lastAudioAtMs: t0 + 12 * min,
      voiceDownSinceMs: t0 + 11 * min,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(h, t0 + 12 * min + 1000)).toBeNull();
  });
});
