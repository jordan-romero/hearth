// Transcription — one audio clip → text, via Deepgram Nova-3. This is the dominant
// cost line (see the pricing model), so it lives here in the functional core and the
// worker stays a thin shell around it. Clips are self-describing WAV, so Deepgram
// sniffs the format — no encoding hints needed. The SDK retries transient failures
// on its own (maxRetries defaults to 2).

import { DeepgramClient } from "@deepgram/sdk";

let client: DeepgramClient | undefined;

function getClient(): DeepgramClient {
  if (client) return client;
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");
  client = new DeepgramClient({ apiKey });
  return client;
}

/** Transcribe a single audio clip to plain text (empty string if it was silence). */
export async function transcribeClip(audio: Buffer): Promise<string> {
  const res = await getClient().listen.v1.media.transcribeFile(audio, {
    model: "nova-3",
    smart_format: true,
    punctuate: true,
  });
  // The async/callback variant returns an AcceptedResponse with no results; we
  // transcribe synchronously, so anything without `results` is treated as empty.
  if (!("results" in res)) return "";
  return res.results.channels[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
