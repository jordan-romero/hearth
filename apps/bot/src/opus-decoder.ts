// Opus → PCM for voice capture.
//
// Native libopus (@discordjs/opus) is the decoder. It's what discord.js voice receivers normally use,
// and it runs as compiled code with ordinary memory.
//
// It replaced opusscript, which runs libopus as WebAssembly with a fixed-size heap shared by the whole
// process. Mid-session on 2026-09-16 that heap faulted ("memory access out of bounds"), and from then
// on every new decoder failed too, so every speaker went silent for the rest of the night.
//
// opusscript stays as the fallback, in case the native binary isn't available on some platform, but
// no longer the way prism-media used it: a decoder that hits a WebAssembly fault retires the heap it
// was on, and the next decoder loads a fresh one. A failure costs the burst it happened in, never the
// recording.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 60 ms at 48 kHz — the longest frame Opus produces, and opusscript's own ceiling. */
const MAX_FRAME_SIZE = 2880;
/** opusscript's input buffer size; anything larger isn't a Discord voice packet. */
const MAX_PACKET_SIZE = 1276 * 3;
const OPUS_APPLICATION_AUDIO = 2049;

interface OpusHandler {
  _decode(inPtr: number, length: number, outPtr: number): number;
}

interface OpusNative {
  OpusScriptHandler: {
    new (rate: number, channels: number, application: number): OpusHandler;
    destroy_handler(handler: OpusHandler): void;
  };
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

interface Heap {
  native: OpusNative;
  generation: number;
}

let heap: Heap | null = null;
let generation = 0;

function currentHeap(): Heap {
  if (!heap) {
    // A factory: each call instantiates a new module with its own memory. opusscript itself calls
    // it once and caches the result forever, which is exactly what we're avoiding.
    const load =
      require("opusscript/build/opusscript_native_wasm.js") as () => OpusNative;
    heap = { native: load(), generation: ++generation };
  }
  return heap;
}

function retire(heapGeneration: number): void {
  if (heap?.generation === heapGeneration) heap = null;
}

/** Which heap new decoders are created on. Exposed for tests and diagnostics. */
export function opusHeapGeneration(): number {
  return currentHeap().generation;
}

/** One speaking burst's decoder. Create it for the burst, decode packets, close it. */
export class BurstDecoder implements OpusBurstDecoder {
  private readonly native: OpusNative;
  private readonly generation: number;
  private readonly handler: OpusHandler;
  private readonly inPtr: number;
  private readonly outPtr: number;
  private closed = false;
  private failed = false;

  constructor(
    private readonly channels: number,
    rate = 48000,
  ) {
    const current = currentHeap();
    this.native = current.native;
    this.generation = current.generation;
    try {
      this.handler = new current.native.OpusScriptHandler(
        rate,
        channels,
        OPUS_APPLICATION_AUDIO,
      );
      this.inPtr = current.native._malloc(MAX_PACKET_SIZE);
      this.outPtr = current.native._malloc(MAX_FRAME_SIZE * channels * 2);
    } catch (err) {
      retire(current.generation);
      throw err;
    }
  }

  /** Decode one Opus packet to 16-bit little-endian PCM. Returns null for a packet libopus rejects
   * (skip it and carry on). Throws if the heap itself has failed — that heap is retired, so the
   * next decoder starts clean. */
  decode(packet: Buffer): Buffer | null {
    if (this.closed || this.failed) return null;
    if (packet.length === 0 || packet.length > MAX_PACKET_SIZE) return null;
    try {
      // Read HEAPU8 fresh on every call rather than caching a view of it.
      this.native.HEAPU8.set(packet, this.inPtr);
      const samples = this.handler._decode(
        this.inPtr,
        packet.length,
        this.outPtr,
      );
      if (samples < 0) return null;
      const bytes = samples * this.channels * 2;
      return Buffer.from(
        this.native.HEAPU8.subarray(this.outPtr, this.outPtr + bytes),
      );
    } catch (err) {
      this.failed = true;
      retire(this.generation);
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Freeing into a heap that has already faulted can fault again; it's being discarded anyway.
    if (this.failed) return;
    try {
      this.native.OpusScriptHandler.destroy_handler(this.handler);
      this.native._free(this.inPtr);
      this.native._free(this.outPtr);
    } catch {
      retire(this.generation);
    }
  }
}

/** What capture needs from a decoder, whichever implementation is behind it. */
export interface OpusBurstDecoder {
  decode(packet: Buffer): Buffer | null;
  close(): void;
}

interface NativeOpusEncoder {
  decode(packet: Buffer): Buffer;
}

type NativeOpus = new (rate: number, channels: number) => NativeOpusEncoder;

let native: NativeOpus | null | undefined;
let nativeError: string | null = null;

function loadNative(): NativeOpus | null {
  if (native !== undefined) return native;
  try {
    native = (require("@discordjs/opus") as { OpusEncoder: NativeOpus })
      .OpusEncoder;
  } catch (err) {
    native = null;
    nativeError = err instanceof Error ? err.message : String(err);
  }
  return native;
}

/** Which decoder capture is using, and why — logged once at startup so a deploy that lost the
 * native binary is visible rather than silent. */
export function opusDecoderKind(): string {
  return loadNative()
    ? "native (@discordjs/opus)"
    : `WebAssembly fallback (native unavailable: ${nativeError})`;
}

class NativeBurstDecoder implements OpusBurstDecoder {
  private readonly encoder: NativeOpusEncoder;
  constructor(Opus: NativeOpus, channels: number, rate: number) {
    this.encoder = new Opus(rate, channels);
  }
  decode(packet: Buffer): Buffer | null {
    if (packet.length === 0) return null;
    try {
      return this.encoder.decode(packet);
    } catch {
      return null; // a packet libopus rejects; native errors don't damage anything else
    }
  }
  close(): void {
    // Freed by the garbage collector.
  }
}

/** A decoder for one speaking burst: native when available, the recoverable WebAssembly one if not. */
export function createBurstDecoder(
  channels: number,
  rate = 48000,
): OpusBurstDecoder {
  const Opus = loadNative();
  return Opus
    ? new NativeBurstDecoder(Opus, channels, rate)
    : new BurstDecoder(channels, rate);
}
