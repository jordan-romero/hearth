// A character's token image, for members of that campaign only. Tokens live in private
// storage; this route is how the web reads one back.

import { auth } from "@/auth";
import { prisma } from "@hearth/db";
import { readCharacterToken, resolveMember } from "@hearth/agents";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string; characterId: string }> },
) {
  const { campaignId, characterId } = await params;
  const session = await auth();
  if (!session?.discordUserId) return notFound();
  const viewer = await resolveMember(campaignId, session.discordUserId);
  if (!viewer) return notFound();

  const character = await prisma.character.findFirst({
    where: { id: characterId, campaignId },
    select: { tokenStoragePath: true },
  });
  if (!character?.tokenStoragePath) return notFound();

  const { data, contentType } = await readCharacterToken(
    character.tokenStoragePath,
  );
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
