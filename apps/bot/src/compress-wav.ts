// WAV → Ogg Opus, for clips recorded before capture stored Opus directly.
//
// Speech at 32 kbps mono Opus is clear to the ear and to Deepgram, and about 24× smaller than the
// 48 kHz 16-bit mono WAV the bot used to write.

import { createRequire } from "node:module";
import OpusScript from "opusscript";
import { oggOpus } from "./ogg-opus.js";

const require = createRequire(import.meta.url);

const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
const BITRATE_PER_CHANNEL = 32_000;
/** libopus's encoder delay, in 48 kHz samples. The decoder drops this much from the start. */
const ENCODER_LOOKAHEAD = 312;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/** Read a PCM WAV's format and samples, walking its chunks rather than assuming a 44-byte header. */
export function parseWav(wav: Buffer): WavInfo {
  if (
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("not a WAV file");
  let fmt: Omit<WavInfo, "pcm"> | null = null;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      if (wav.readUInt16LE(body) !== 1) throw new Error("WAV isn't plain PCM");
      fmt = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before its format");
      return {
        ...fmt,
        pcm: wav.subarray(body, Math.min(body + size, wav.length)),
      };
    }
    at = body + size + (size & 1); // chunks are padded to an even length
  }
  throw new Error("WAV has no data");
}

interface Encoder {
  encode(frame: Buffer): Buffer;
  close(): void;
}

function createEncoder(rate: number, channels: number): Encoder {
  const bitrate = BITRATE_PER_CHANNEL * channels;
  try {
    const { OpusEncoder } = require("@discordjs/opus") as {
      OpusEncoder: new (
        rate: number,
        channels: number,
      ) => { encode(pcm: Buffer): Buffer; setBitrate(bps: number): void };
    };
    const native = new OpusEncoder(rate, channels);
    native.setBitrate(bitrate);
    return { encode: (f) => native.encode(f), close: () => {} };
  } catch {
    const wasm = new OpusScript(
      rate as 48000,
      channels,
      OpusScript.Application.AUDIO,
    );
    wasm.setBitrate(bitrate);
    const frameSamples = rate / 50;
    return {
      encode: (f) => Buffer.from(wasm.encode(f, frameSamples)),
      close: () => wasm.delete(),
    };
  }
}

/** Re-encode a 16-bit PCM WAV as Ogg Opus. */
export function wavToOggOpus(wav: Buffer): Buffer {
  const { sampleRate, channels, bitsPerSample, pcm } = parseWav(wav);
  if (bitsPerSample !== 16)
    throw new Error(`${bitsPerSample}-bit WAV isn't supported`);
  if (!OPUS_RATES.has(sampleRate))
    throw new Error(`${sampleRate} Hz isn't an Opus rate`);
  if (channels !== 1 && channels !== 2)
    throw new Error(`${channels}-channel WAV isn't supported`);

  const frameBytes = (sampleRate / 50) * channels * 2; // 20 ms frames
  const encoder = createEncoder(sampleRate, channels);
  const packets: Buffer[] = [];
  try {
    for (let at = 0; at < pcm.length; at += frameBytes) {
      let frame = pcm.subarray(at, at + frameBytes);
      if (frame.length < frameBytes) {
        // Pad the last frame with silence; Opus only encodes whole frames.
        const padded = Buffer.alloc(frameBytes);
        frame.copy(padded);
        frame = padded;
      }
      packets.push(encoder.encode(frame));
    }
  } finally {
    encoder.close();
  }
  return oggOpus(packets, {
    channels,
    preSkip: ENCODER_LOOKAHEAD,
    inputSampleRate: sampleRate,
  });
}
