import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpusScript from "opusscript";
import { oggOpus, opusPacketSamples } from "./ogg-opus.js";

// `seconds` of a 440 Hz tone as 20 ms stereo packets, like a Discord voice burst.
function tonePackets(seconds: number): Buffer[] {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const packets: Buffer[] = [];
  for (let f = 0; f < seconds * 50; f++) {
    const frame = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++) {
      const t = f * 960 + i;
      const s = Math.round(Math.sin((2 * Math.PI * 440 * t) / 48000) * 8000);
      frame.writeInt16LE(s, i * 4);
      frame.writeInt16LE(s, i * 4 + 2);
    }
    packets.push(Buffer.from(encoder.encode(frame, 960)));
  }
  encoder.delete();
  return packets;
}

/** Split an Ogg file into its pages' headers. */
function pages(file: Buffer) {
  const out: { flags: number; granule: bigint; sequence: number }[] = [];
  let at = 0;
  while (at < file.length) {
    expect(file.toString("ascii", at, at + 4)).toBe("OggS");
    const segments = file[at + 26]!;
    let body = 0;
    for (let i = 0; i < segments; i++) body += file[at + 27 + i]!;
    out.push({
      flags: file[at + 5]!,
      granule: file.readBigInt64LE(at + 6),
      sequence: file.readUInt32LE(at + 18),
    });
    at += 27 + segments + body;
  }
  return out;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("opusPacketSamples", () => {
  it("reads a 20 ms CELT packet as 960 samples", () => {
    expect(opusPacketSamples(tonePackets(0.02)[0]!)).toBe(960);
  });

  it("reads Discord's silence frame (0xF8 0xFF 0xFE) as 20 ms", () => {
    expect(opusPacketSamples(Buffer.from([0xf8, 0xff, 0xfe]))).toBe(960);
  });

  it("counts every frame of a multi-frame packet", () => {
    // config 31 (CELT 20 ms), code 3, with 3 frames
    expect(opusPacketSamples(Buffer.from([(31 << 3) | 3, 3]))).toBe(2880);
  });
});

describe("oggOpus", () => {
  it("opens with the two header pages, then ends the stream on the last page", () => {
    const file = oggOpus(tonePackets(3), { channels: 2 });
    const ps = pages(file);
    expect(file.toString("ascii", 28, 36)).toBe("OpusHead");
    expect(ps[0]!.flags).toBe(0x02);
    expect(ps.map((p) => p.sequence)).toEqual(ps.map((_, i) => i));
    expect(ps.at(-1)!.flags).toBe(0x04);
    // 150 packets × 960 samples, and the final granule counts every one
    expect(ps.at(-1)!.granule).toBe(150n * 960n);
  });

  it("includes the pre-skip in the granule position", () => {
    const ps = pages(oggOpus(tonePackets(1), { channels: 2, preSkip: 312 }));
    expect(ps.at(-1)!.granule).toBe(312n + 50n * 960n);
  });

  it("still writes a valid, ended stream when there is no audio", () => {
    const ps = pages(oggOpus([], { channels: 2 }));
    expect(ps).toHaveLength(3);
    expect(ps.at(-1)!.flags).toBe(0x04);
  });

  it("is far smaller than the PCM it holds", () => {
    const file = oggOpus(tonePackets(5), { channels: 2 });
    const monoPcmBytes = 5 * 48000 * 2;
    expect(file.length).toBeLessThan(monoPcmBytes / 5);
  });

  it.runIf(hasFfmpeg())(
    "decodes in a real player to the right length, with no errors",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ogg-opus-"));
      const file = path.join(dir, "clip.ogg");
      fs.writeFileSync(file, oggOpus(tonePackets(3), { channels: 2 }));
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
      expect(duration).toBeCloseTo(3, 1);
      // -xerror makes ffmpeg fail on anything it would only have warned about (CRC, framing).
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
    },
  );
});
