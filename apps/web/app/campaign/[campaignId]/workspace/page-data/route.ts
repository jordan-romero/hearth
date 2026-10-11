// Pages for the browser to keep (?ids=a,b,c, up to 25): the workspace fetches pages ahead —
// on hover, and the whole workspace in the background — so opening one needs no round trip.
// DM-only; ids are scoped to the campaign in the URL.

import { getPageDocs } from "@/lib/page-docs";
import { requireDm } from "@/lib/campaign";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  await requireDm(campaignId);
  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Response.json(await getPageDocs(campaignId, ids), {
    headers: { "cache-control": "private, no-store" },
  });
}
