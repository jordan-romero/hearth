// Encryption for credentials Hearth has to keep — today, a DM's OneNote refresh token, which can
// read every notebook on their Microsoft account. AES-256-GCM, so a tampered value fails to
// decrypt rather than decrypting to garbage.
//
// The key is HEARTH_ENCRYPTION_KEY: its own secret, not AUTH_SECRET, so the worker that reads
// these tokens never needs the key that protects website sign-ins. Each use derives a key with a
// purpose label, so a value sealed for one purpose can't be opened as another. Rotating
// HEARTH_ENCRYPTION_KEY makes stored tokens unreadable: the DM simply connects again.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
// Pinned so a truncated tag is refused: GCM otherwise accepts tags as short as 4 bytes, which
// makes forging a value far easier.
const TAG_BYTES = 16;

function key(purpose: string): Buffer {
  const secret = process.env.HEARTH_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "HEARTH_ENCRYPTION_KEY is not set (or too short) — can't seal credentials",
    );
  }
  return Buffer.from(
    hkdfSync("sha256", secret, "hearth", `hearth:${purpose}`, 32),
  );
}

/** Whether credentials can be sealed here at all. */
export function canSealSecrets(): boolean {
  return (process.env.HEARTH_ENCRYPTION_KEY?.length ?? 0) >= 32;
}

/** Encrypt `plain` for storage. `purpose` must be the same when decrypting. */
export function sealSecret(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv, {
    authTagLength: TAG_BYTES,
  });
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/** Decrypt a value from sealSecret. Throws if it was tampered with or sealed for another purpose. */
export function openSecret(sealed: string, purpose: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error("not a sealed secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(purpose),
    Buffer.from(iv, "base64url"),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
