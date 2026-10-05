// Encryption for credentials Hearth has to keep — today, a DM's OneNote refresh token, which can
// read every notebook on their Microsoft account. AES-256-GCM, so a tampered value fails to
// decrypt rather than decrypting to garbage.
//
// The key is derived from AUTH_SECRET (already set wherever Hearth runs, and already a secret)
// with a purpose label, so this key and Auth.js's own keys never coincide. Rotating AUTH_SECRET
// makes stored tokens unreadable: the DM simply connects again.

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
  const secret = process.env.AUTH_SECRET;
  if (!secret)
    throw new Error("AUTH_SECRET is not set — can't encrypt credentials");
  return Buffer.from(
    hkdfSync("sha256", secret, "hearth", `hearth:${purpose}`, 32),
  );
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
