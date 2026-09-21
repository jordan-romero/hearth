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
/** Nothing to post, nothing to clear. */
const quiet = { alert: null, recovered: false };

describe("checkHealth", () => {
  it("stays quiet while audio is flowing", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 5 * min,
      lastAudioAtMs: t0 + 5 * min - 1000,
    };
    expect(checkHealth(h, t0 + 5 * min + 10_000)).toEqual(quiet);
  });

  it("warns when people are talking but no audio has come through — last night's failure", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 10 * min,
      lastAudioAtMs: t0 + 1 * min,
    };
    expect(checkHealth(h, t0 + 10 * min + 5_000)).toEqual({
      alert: { kind: "no-audio" },
      recovered: false,
    });
  });

  it("doesn't warn when nobody is talking (a break, or everyone muted)", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 1 * min,
      lastAudioAtMs: t0 + 1 * min,
    };
    expect(checkHealth(h, t0 + 30 * min)).toEqual(quiet);
  });

  it("doesn't warn before the gap is long enough", () => {
    const h = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 90_000,
      lastAudioAtMs: null,
    };
    expect(checkHealth(h, t0 + NO_AUDIO_MS - 1)).toEqual(quiet);
  });

  it("warns when clips keep failing to save", () => {
    const h = {
      ...newHealth(t0),
      consecutiveSaveFailures: SAVE_FAILURES_TO_WARN,
    };
    expect(checkHealth(h, t0 + min)).toEqual({
      alert: { kind: "not-saving" },
      recovered: false,
    });
  });

  it("warns once, not every check", () => {
    const warned = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 10 * min,
      lastAudioAtMs: t0,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(warned, t0 + 11 * min)).toEqual(quiet);
  });

  it("clears the warning when audio comes back, without posting anything", () => {
    const back = {
      ...newHealth(t0),
      lastSpeakingAtMs: t0 + 12 * min,
      lastAudioAtMs: t0 + 12 * min,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(back, t0 + 12 * min + 1000)).toEqual({
      alert: null,
      recovered: true,
    });
  });

  it("warns when the voice connection stays down, not for a reconnect blip", () => {
    const down = { ...newHealth(t0), voiceDownSinceMs: t0 + min };
    expect(checkHealth(down, t0 + min + 5_000)).toEqual(quiet);
    expect(checkHealth(down, t0 + min + VOICE_DOWN_MS)).toEqual({
      alert: { kind: "voice-lost" },
      recovered: false,
    });
  });

  it("isn't recovered while the connection is still down", () => {
    const h = {
      ...newHealth(t0),
      lastAudioAtMs: t0 + 12 * min,
      voiceDownSinceMs: t0 + 11 * min,
      warnedAtMs: t0 + 10 * min,
    };
    expect(checkHealth(h, t0 + 12 * min + 1000)).toEqual(quiet);
  });
});
