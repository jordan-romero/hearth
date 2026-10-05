// The original file an imported Word/PDF page came from, for download. DM-only, like the page.

import { pageOriginal } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ campaignId: string; pageId: string }> },
) {
  const { campaignId, pageId } = await params;
  await requireDm(campaignId);
  const original = await pageOriginal(campaignId, pageId);
  if (!original) return new Response("Not found", { status: 404 });
  const name = original.fileName.replace(/["\\\r\n]/g, "_");
  return new Response(new Uint8Array(original.data), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(original.fileName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
