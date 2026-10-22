import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWav, wavToOggOpus } from "./compress-wav.js";

/** A mono 48 kHz WAV of `seconds` of a 440 Hz tone — the format the bot used to store. */
function toneWav(seconds: number, extraChunk = false): Buffer {
  const samples = Math.round(seconds * 48000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000),
      i * 2,
    );
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(48000, 12);
  fmt.writeUInt32LE(96000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.from("LIST\x03\x00\x00\x00abc\x00", "binary"); // odd size, padded
  const data = Buffer.alloc(8);
  data.write("data", 0);
  data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, ...(extraChunk ? [list] : []), data, pcm]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WAVE", 8);
  return Buffer.concat([riff, body]);
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("parseWav", () => {
  it("reads the format and samples", () => {
    const info = parseWav(toneWav(1));
    expect(info).toMatchObject({
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 16,
    });
    expect(info.pcm.length).toBe(96000);
  });

  it("skips chunks it doesn't know, including odd-sized ones", () => {
    expect(parseWav(toneWav(1, true)).pcm.length).toBe(96000);
  });

  it("refuses something that isn't a WAV", () => {
    expect(() => parseWav(Buffer.from("OggS not a wav at all"))).toThrow();
  });
});

describe("wavToOggOpus", () => {
  it("is many times smaller than the WAV", () => {
    const wav = toneWav(5);
    expect(wavToOggOpus(wav).length).toBeLessThan(wav.length / 10);
  });

  it.runIf(hasFfmpeg())("keeps the clip's length, and decodes cleanly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compress-wav-"));
    const file = path.join(dir, "clip.ogg");
    fs.writeFileSync(file, wavToOggOpus(toneWav(2.5)));
    const duration = Number(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        file,
      ]).toString(),
    );
    // within a frame of the original, which is padded to whole 20 ms frames
    expect(Math.abs(duration - 2.5)).toBeLessThan(0.03);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
    fs.rmSync(dir, { recursive: true });
  });
});
