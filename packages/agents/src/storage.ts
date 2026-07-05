// Clip storage. Two backends behind one interface (putClip/getClip):
//   • Supabase Storage — used in prod (bot and worker are separate containers with
//     no shared disk), enabled when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//   • Local disk — the zero-config dev fallback, anchored at the repo root so the bot
//     and worker share one directory regardless of cwd.
// The bot writes clips (putClip); the worker reads them (getClip). Swapping to S3/R2
// later means only adding a third branch here — nothing else changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.HEARTH_STORAGE_BUCKET ?? "recordings";
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

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

async function putSupabase(key: string, data: Buffer): Promise<string> {
  const { error } = await client()
    .storage.from(BUCKET)
    .upload(key, data, { contentType: "audio/wav", upsert: true });
  if (error)
    throw new Error(`storage upload failed (${key}): ${error.message}`);
  return key;
}

async function getSupabase(key: string): Promise<Buffer> {
  const { data, error } = await client().storage.from(BUCKET).download(key);
  if (error || !data)
    throw new Error(`storage download failed (${key}): ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// ── Local-disk backend (dev) ─────────────────────────────────────────────────
// Anchor to the repo root (…/packages/agents/{src,dist} → up 3).
const BASE =
  process.env.HEARTH_STORAGE_DIR ??
  fileURLToPath(new URL("../../../.hearth-recordings", import.meta.url));

async function putDisk(key: string, data: Buffer): Promise<string> {
  const full = path.join(BASE, key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, data);
  return key;
}

async function getDisk(key: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(BASE, key));
}

// ── Public interface ─────────────────────────────────────────────────────────
/** Store a clip's bytes under `key`; returns the key (the AudioClip.storagePath). */
export async function putClip(key: string, data: Buffer): Promise<string> {
  return useSupabase ? putSupabase(key, data) : putDisk(key, data);
}

/** Read a stored clip's bytes back (for transcription). */
export async function getClip(key: string): Promise<Buffer> {
  return useSupabase ? getSupabase(key) : getDisk(key);
}
