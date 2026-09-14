// A player's token image for their character. Stored privately beside NPC portraits; the web
// app reads it back through a members-only route, so the bucket never needs to be public.

import { prisma } from "@hearth/db";
import { getObject, putObject, PORTRAITS_BUCKET } from "./storage.js";

export const TOKEN_MAX_BYTES = 5 * 1024 * 1024;

const TOKEN_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const;

export type TokenImageType = keyof typeof TOKEN_TYPES;

function hasSignature(type: TokenImageType, data: Buffer): boolean {
  switch (type) {
    case "png":
      return data
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "jpg":
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "gif":
      return data.subarray(0, 4).toString("latin1") === "GIF8";
    case "webp":
      return (
        data.subarray(0, 4).toString("latin1") === "RIFF" &&
        data.subarray(8, 12).toString("latin1") === "WEBP"
      );
  }
}

/** The accepted image type for an upload, or null. The declared type comes from the uploader,
 * so the bytes have to agree with it — a mislabelled file is refused rather than served. */
export function tokenImageType(
  contentType: string | null | undefined,
  data: Buffer,
): TokenImageType | null {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  const type = (Object.keys(TOKEN_TYPES) as TokenImageType[]).find(
    (t) => TOKEN_TYPES[t] === mime,
  );
  return type && hasSignature(type, data) ? type : null;
}

/** Store a character's token and point the character at it. */
export async function saveCharacterToken(
  campaignId: string,
  characterId: string,
  data: Buffer,
  type: TokenImageType,
): Promise<void> {
  const key = await putObject(
    PORTRAITS_BUCKET,
    `tokens/${campaignId}/${characterId}.${type}`,
    data,
    TOKEN_TYPES[type],
  );
  await prisma.character.update({
    where: { id: characterId },
    data: { tokenStoragePath: key },
  });
}

/** Read a stored token back with the content type it was saved as. */
export async function readCharacterToken(
  key: string,
): Promise<{ data: Buffer; contentType: string }> {
  const ext = key.slice(key.lastIndexOf(".") + 1) as TokenImageType;
  return {
    data: await getObject(PORTRAITS_BUCKET, key),
    contentType: TOKEN_TYPES[ext] ?? "application/octet-stream",
  };
}
