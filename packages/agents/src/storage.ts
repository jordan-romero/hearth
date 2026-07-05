// Clip storage abstraction. Local disk for now (dev); swap to Supabase Storage
// before deploy by re-implementing putClip/getClip — nothing else changes.
// The bot writes clips (putClip); the worker reads them (getClip).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Anchor to the repo root (…/packages/agents/{src,dist} → up 3) so the bot and the
// worker share one directory no matter which package's cwd they were started from.
const DEFAULT_DIR = fileURLToPath(
  new URL("../../../.hearth-recordings", import.meta.url),
);
const BASE = process.env.HEARTH_STORAGE_DIR ?? DEFAULT_DIR;

/** Store a clip's bytes under `key`; returns the key (the AudioClip.storagePath). */
export async function putClip(key: string, data: Buffer): Promise<string> {
  const full = path.join(BASE, key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, data);
  return key;
}

/** Read a stored clip's bytes back (for transcription). */
export async function getClip(key: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(BASE, key));
}
