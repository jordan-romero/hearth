// Object storage. Two backends behind one interface (putObject/getObject), keyed by
// bucket:
//   • Supabase Storage — prod (bot and worker are separate containers with no shared
//     disk), enabled when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//   • Local disk — the zero-config dev fallback, anchored at the repo root so every
//     process shares one directory regardless of cwd.
// Buckets: `recordings` (audio clips) and `documents` (DM source files). Swapping to
// S3/R2 later means only touching putObject/getObject — nothing else changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

export const RECORDINGS_BUCKET =
  process.env.HEARTH_STORAGE_BUCKET ?? "recordings";
export const DOCUMENTS_BUCKET =
  process.env.HEARTH_DOCUMENTS_BUCKET ?? "documents";
export const PORTRAITS_BUCKET =
  process.env.HEARTH_PORTRAITS_BUCKET ?? "portraits";

// ── Supabase Storage backend ─────────────────────────────────────────────────
let sb: SupabaseClient | undefined;
function client(): SupabaseClient {
  if (!sb) {
    sb = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { persistSession: false }, // trusted backend; no user session
    });
  }
  return sb;
}

// ── Local-disk backend (dev) ─────────────────────────────────────────────────
// General storage root, anchored to the repo root (…/packages/agents/{src,dist} → up 3);
// each bucket is a subdirectory.
const BASE =
  process.env.HEARTH_STORAGE_DIR ??
  fileURLToPath(new URL("../../../.hearth-storage", import.meta.url));

// ── Public interface ─────────────────────────────────────────────────────────
/** Store `data` under `bucket`/`key`; returns the key. */
export async function putObject(
  bucket: string,
  key: string,
  data: Buffer,
  contentType?: string,
): Promise<string> {
  if (useSupabase) {
    const { error } = await client()
      .storage.from(bucket)
      .upload(key, data, { contentType, upsert: true });
    if (error)
      throw new Error(
        `storage upload failed (${bucket}/${key}): ${error.message}`,
      );
    return key;
  }
  const full = path.join(BASE, bucket, key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, data);
  return key;
}

/** Read `bucket`/`key` back. */
export async function getObject(bucket: string, key: string): Promise<Buffer> {
  if (useSupabase) {
    const { data, error } = await client().storage.from(bucket).download(key);
    if (error || !data)
      throw new Error(
        `storage download failed (${bucket}/${key}): ${error?.message}`,
      );
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.promises.readFile(path.join(BASE, bucket, key));
}

// Per-bucket convenience wrappers.
/** Store a clip's bytes (bot) — returns the key (AudioClip.storagePath). */
export const putClip = (key: string, data: Buffer): Promise<string> =>
  putObject(RECORDINGS_BUCKET, key, data, "audio/wav");
/** Read a stored clip back (worker). */
export const getClip = (key: string): Promise<Buffer> =>
  getObject(RECORDINGS_BUCKET, key);
/** Store a DM source file — returns the key (SourceDocument.storagePath). */
export const putDocument = (
  key: string,
  data: Buffer,
  contentType?: string,
): Promise<string> => putObject(DOCUMENTS_BUCKET, key, data, contentType);
/** Read a stored source file back (ingestion). */
export const getDocument = (key: string): Promise<Buffer> =>
  getObject(DOCUMENTS_BUCKET, key);
/** Store an NPC portrait/token — returns the key (Asset.storagePath). */
export const putPortrait = (key: string, data: Buffer): Promise<string> =>
  putObject(PORTRAITS_BUCKET, key, data, "image/png");
/** Read a stored portrait back (NPC card + matching). */
export const getPortrait = (key: string): Promise<Buffer> =>
  getObject(PORTRAITS_BUCKET, key);
