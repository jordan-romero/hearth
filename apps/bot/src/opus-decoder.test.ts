import { describe, it, expect } from "vitest";
import OpusScript from "opusscript";
import {
  BurstDecoder,
  createBurstDecoder,
  opusDecoderKind,
  opusHeapGeneration,
} from "./opus-decoder.js";

// A real Opus packet: 20 ms of a 440 Hz tone, stereo, encoded by the same WebAssembly build.
function tonePacket(): Buffer {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const frame = Buffer.alloc(960 * 2 * 2);
  for (let i = 0; i < 960; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000);
    frame.writeInt16LE(sample, i * 4);
    frame.writeInt16LE(sample, i * 4 + 2);
  }
  const packet = encoder.encode(frame, 960);
  encoder.delete();
  return packet;
}

describe("BurstDecoder", () => {
  it("decodes a real packet to 20 ms of stereo 16-bit PCM", () => {
    const decoder = new BurstDecoder(2);
    const pcm = decoder.decode(tonePacket());
    decoder.close();
    expect(pcm?.length).toBe(960 * 2 * 2);
  });

  it("skips a packet libopus rejects instead of failing the burst", () => {
    const decoder = new BurstDecoder(2);
    expect(decoder.decode(Buffer.alloc(0))).toBeNull();
    expect(decoder.decode(Buffer.alloc(5000))).toBeNull();
    expect(decoder.decode(tonePacket())?.length).toBe(3840);
    decoder.close();
  });

  it("survives thousands of bursts — decoders are freed, not leaked", () => {
    // The heap can't grow, so a leak per burst would fault within a session.
    const packet = tonePacket();
    const before = opusHeapGeneration();
    for (let i = 0; i < 5000; i++) {
      const decoder = new BurstDecoder(2);
      decoder.decode(packet);
      decoder.close();
    }
    expect(opusHeapGeneration()).toBe(before);
  });

  it("retires a faulted heap so the next burst decodes on a fresh one", () => {
    // What happened at the table: one WebAssembly fault, then every later decoder failed too.
    const broken = new BurstDecoder(2);
    const before = opusHeapGeneration();
    (
      broken as unknown as { handler: { _decode: () => number } }
    ).handler._decode = () => {
      // Node throws WebAssembly.RuntimeError here; its types aren't in this lib config.
      throw Object.assign(new Error("memory access out of bounds"), {
        name: "RuntimeError",
      });
    };
    expect(() => broken.decode(tonePacket())).toThrow(
      "memory access out of bounds",
    );
    broken.close(); // must not touch the faulted heap, or throw

    expect(opusHeapGeneration()).toBe(before + 1);
    const fresh = new BurstDecoder(2);
    expect(fresh.decode(tonePacket())?.length).toBe(3840);
    fresh.close();
  });
});

describe("createBurstDecoder", () => {
  it("uses native Opus when it's installed", () => {
    expect(opusDecoderKind()).toBe("native (@discordjs/opus)");
  });

  it("decodes a real packet and skips an empty one", () => {
    const decoder = createBurstDecoder(2);
    expect(decoder.decode(tonePacket())?.length).toBe(960 * 2 * 2);
    expect(decoder.decode(Buffer.alloc(0))).toBeNull();
    decoder.close();
  });
});
