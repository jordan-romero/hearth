// Opus packets → an Ogg Opus file (RFC 7845), with no re-encoding.
//
// Discord already sends voice as Opus, so a clip can be stored as exactly the packets that arrived:
// no quality lost and a tenth of the bytes of the PCM they decode to. Deepgram reads Ogg Opus, and
// so does every browser. The container is simple enough to write by hand, which keeps the bot free
// of another native addon.

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++)
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value 0. */
function oggCrc(data: Buffer): number {
  let crc = 0;
  for (const byte of data)
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** Samples (at 48 kHz) one Opus packet decodes to, read from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Buffer): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12)
    frameSamples = [480, 960, 1920, 2880][config & 3]!; // SILK: 10/20/40/60 ms
  else if (config < 16)
    frameSamples = config & 1 ? 960 : 480; // hybrid: 10/20 ms
  else frameSamples = [120, 240, 480, 960][config & 3]!; // CELT: 2.5/5/10/20 ms
  const code = toc & 3;
  const frames =
    code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 0;
  return frames * frameSamples;
}

const SERIAL = 0x4865_6172; // "Hear" — any value works for a single-stream file
// Packets per audio page. Discord sends 20 ms packets, so this is about a second per page: small
// enough that a player can seek, large enough that page headers stay a rounding error.
const PACKETS_PER_PAGE = 50;

function page(
  packets: Buffer[],
  sequence: number,
  granule: bigint,
  flags: number,
): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n); // a packet ending exactly on 255 still needs this closing 0
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0);
  header.writeUInt8(0, 4); // version
  header.writeUInt8(flags, 5);
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(SERIAL, 14);
  header.writeUInt32LE(sequence, 18);
  // bytes 22–25: CRC, filled in below over the whole page with this field zeroed
  header.writeUInt8(lacing.length, 26);
  lacing.forEach((v, i) => header.writeUInt8(v, 27 + i));
  const out = Buffer.concat([header, ...packets]);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

/** Whether these packets fit one page's 255 lacing values. */
function lacingCount(packets: Buffer[]): number {
  return packets.reduce((n, p) => n + Math.floor(p.length / 255) + 1, 0);
}

export interface OggOpusOptions {
  /** Channel count the packets were encoded with (Discord voice is 2). */
  channels: number;
  /** Samples the decoder drops from the start: the encoder's lookahead, or 0 for packets copied
   * from a live stream that has already been running. */
  preSkip?: number;
  /** The rate of the original audio, recorded for players; Opus itself always runs at 48 kHz. */
  inputSampleRate?: number;
}

/** Wrap Opus packets, in order, in an Ogg Opus file. */
export function oggOpus(packets: Buffer[], options: OggOpusOptions): Buffer {
  const { channels, preSkip = 0, inputSampleRate = 48000 } = options;

  const head = Buffer.alloc(19);
  head.write("OpusHead", 0);
  head.writeUInt8(1, 8); // version
  head.writeUInt8(channels, 9);
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(inputSampleRate, 12);
  head.writeInt16LE(0, 16); // output gain
  head.writeUInt8(0, 18); // channel mapping family 0: mono or stereo

  const vendor = Buffer.from("hearth");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0);
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no comments

  const pages = [page([head], 0, 0n, 0x02), page([tags], 1, 0n, 0)];
  const audio = packets.filter((p) => p.length > 0);
  let sequence = 2;
  let granule = BigInt(preSkip);
  for (let i = 0; i < audio.length;) {
    const batch: Buffer[] = [];
    while (
      i < audio.length &&
      batch.length < PACKETS_PER_PAGE &&
      lacingCount([...batch, audio[i]!]) <= 255
    ) {
      batch.push(audio[i]!);
      granule += BigInt(opusPacketSamples(audio[i]!));
      i++;
    }
    pages.push(page(batch, sequence++, granule, i >= audio.length ? 0x04 : 0));
  }
  if (audio.length === 0) {
    // A file with no audio still needs a page that ends the stream.
    pages.push(page([], sequence, granule, 0x04));
  }
  return Buffer.concat(pages);
}
