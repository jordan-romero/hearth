// Live transcription — a speaker's audio transcribed WHILE they talk.
//
// Why this exists, precisely: the batch path ends a clip after 1.5s of silence and only then
// transcribes it. Ordinary back-and-forth reaches the memory within seconds that way, which is
// fine — but someone who talks continuously produces ONE clip that isn't transcribed until they
// stop. The DM narrating for four minutes contributes nothing for those four minutes, and the
// DM is who narrates. Streaming closes exactly that gap: Deepgram finalizes at natural pauses,
// so a monologue lands in pieces as it happens.
//
// This runs ALONGSIDE the batch path rather than replacing it. The clip is still stored and
// still transcribed, so a dropped socket costs freshness, never the session.

// The Deepgram SDK's live client connects and then closes without ever opening (verified
// against a raw socket that works with the identical key and URL), so we speak the websocket
// protocol directly. It's a documented, stable interface and one fewer layer to debug.
import WebSocket from "ws";

const DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen";

/** Discord voice decodes to 48kHz; we downmix to mono before sending (half the bytes). */
const SAMPLE_RATE = 48000;

/** Silence (ms) after which Deepgram finalizes what it has. Short enough that a monologue
 * arrives in pieces at natural pauses, long enough not to shred sentences mid-breath. */
const ENDPOINTING_MS = 300;

/** Deepgram closes an idle socket; a speaker pausing to think shouldn't drop the connection. */
const KEEPALIVE_MS = 8000;

export interface TranscriptStream {
  /** Feed mono 16-bit PCM as it arrives. No-op once closed. */
  send(pcm: Buffer): void;
  /** Flush and close. Resolves once Deepgram has acknowledged or the timeout elapses. */
  close(): Promise<void>;
}

export interface StreamOptions {
  /** Called for each FINALIZED span of speech. Interim guesses are deliberately not surfaced:
   * they get revised, and a recap built from words nobody said is worse than a late one. */
  onFinal: (text: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Open a live transcription socket for one speaker.
 *
 * One socket per speaking burst, not per session: Deepgram bills by connected time, so a
 * connection held open through an hour of listening is an hour billed. The caller opens on
 * `speaking.start` and closes when the burst ends.
 */
export async function openTranscriptStream(
  opts: StreamOptions,
): Promise<TranscriptStream> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

  const params = new URLSearchParams({
    model: "nova-3",
    // We send raw decoded PCM rather than a container, so the format has to be declared.
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    // Interim guesses get revised; a recap built from words nobody said is worse than a late
    // one, so only finalized spans are surfaced.
    interim_results: "false",
    endpointing: String(ENDPOINTING_MS),
  });

  const ws = new WebSocket(`${DEEPGRAM_WS}?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let closed = false;

  ws.on("message", (raw: WebSocket.RawData) => {
    let msg: {
      is_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // metadata frames we don't model
    }
    if (!msg.is_final) return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (text) opts.onFinal(text);
  });

  ws.on("error", (err: Error) => {
    // A streaming failure costs freshness, never correctness — the batch path transcribes this
    // same audio regardless. Report it and let the burst finish.
    console.error("[stream] transcription socket error:", err.message);
    opts.onError?.(err);
  });

  ws.on("close", () => {
    closed = true;
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("deepgram socket did not open in 10s")),
      10_000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const keepAlive = setInterval(() => {
    if (!closed && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, KEEPALIVE_MS);

  return {
    send(pcm: Buffer): void {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(pcm);
    },
    async close(): Promise<void> {
      clearInterval(keepAlive);
      if (closed) return;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          // Ask for anything still buffered before hanging up, so the tail of a sentence isn't
          // lost — then close regardless, because a burst must never block on the network.
          ws.send(JSON.stringify({ type: "Finalize" }));
          await new Promise((r) => setTimeout(r, 300));
          ws.send(JSON.stringify({ type: "CloseStream" }));
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch {
        // Already gone.
      } finally {
        closed = true;
        ws.close();
      }
    },
  };
}
