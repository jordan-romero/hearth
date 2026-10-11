// Pages that name this one without linking it (?id=…), for "Unlinked mentions" under a page.
// DM-only; scoped to the campaign in the URL.

import { getUnlinkedMentions } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  await requireDm(campaignId);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return Response.json(id ? await getUnlinkedMentions(campaignId, id) : [], {
    headers: { "cache-control": "private, no-store" },
  });
}
