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

export const FINALIZE_QUEUE = "finalize";

/** A game session queued for finalization — extraction over ALL its recordings, then marking
 * it COMPLETE. Scheduled (delayed by the gap window) on /stop; if the session resumed within
 * the window, the job reschedules itself instead of finalizing. */
export interface FinalizeJob {
  gameSessionId: string;
}

export const INGEST_QUEUE = "ingest";

/** A stored SourceDocument, queued for parse → chunk → embed (the RAG layer). */
export interface IngestJob {
  sourceDocumentId: string;
}

/** A stop→restart gap longer than this ends the session. It's BOTH the `/record` merge window
 * (a restart within it resumes the same session) and the `/stop`→finalize delay. Override with
 * HEARTH_SESSION_GAP_MIN (fractional minutes ok — set it tiny to test the lifecycle fast). */
export const SESSION_GAP_MS =
  (Number(process.env.HEARTH_SESSION_GAP_MIN) || 30) * 60_000;
export const SESSION_GAP_SEC = Math.max(1, Math.round(SESSION_GAP_MS / 1000));
