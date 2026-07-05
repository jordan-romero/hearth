// Async job contracts, shared by the bot (enqueue side) and the worker (handle side)
// so the queue name and payload shape can never drift between them.

export const TRANSCRIBE_QUEUE = "transcribe";

/** One captured speaking-burst clip, queued for Deepgram transcription. */
export interface TranscribeJob {
  recordingId: string;
  audioClipId: string;
  storageKey: string; // where the clip lives (storage.ts)
  discordUserId: string;
  characterId: string | null;
  startMs: number;
  durationMs: number;
}
