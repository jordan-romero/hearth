// Microsoft sends the DM back here after sign-in. The state must match the cookie set when they
// left, and the signed-in Hearth user must still be this campaign's DM — both checked before the
// account is stored.

import { NextResponse, type NextRequest } from "next/server";
import { connectOneNote } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import {
  STATE_COOKIE,
  campaignForState,
  oneNoteRedirectUri,
} from "@/lib/onenote";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const campaignId = campaignForState(
    req.cookies.get(STATE_COOKIE)?.value,
    params.get("state"),
  );
  if (!campaignId) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  const { viewer } = await requireDm(campaignId);

  const back = (outcome: string) => {
    const res = NextResponse.redirect(
      new URL(
        `/campaign/${campaignId}/workspace/import?onenote=${outcome}#onenote`,
        req.url,
      ),
    );
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/onenote" });
    return res;
  };

  const code = params.get("code");
  if (!code) return back("cancelled"); // they backed out, or declined the permission

  try {
    await connectOneNote({
      campaignId,
      membershipId: viewer.membershipId,
      code,
      redirectUri: oneNoteRedirectUri(req.nextUrl.origin),
    });
  } catch (err) {
    console.error("OneNote connect failed:", err);
    return back("failed");
  }
  return back("connected");
}
