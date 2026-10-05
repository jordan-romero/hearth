// Start connecting OneNote: send the DM to Microsoft's sign-in. DM-only — a player asking gets
// the same 404 as any other DM-only page.

import { NextResponse, type NextRequest } from "next/server";
import { oneNoteAuthorizeUrl, oneNoteConfigured } from "@hearth/agents";
import { requireDm } from "@/lib/campaign";
import { STATE_COOKIE, newState, oneNoteRedirectUri } from "@/lib/onenote";

export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaignId") ?? "";
  await requireDm(campaignId);
  if (!oneNoteConfigured()) {
    return NextResponse.redirect(
      new URL(
        `/campaign/${campaignId}/library?onenote=unavailable#onenote`,
        req.url,
      ),
    );
  }

  const { state, cookie } = newState(campaignId);
  const res = NextResponse.redirect(
    oneNoteAuthorizeUrl(oneNoteRedirectUri(req.nextUrl.origin), state),
  );
  res.cookies.set(STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    // Lax still rides along on Microsoft's top-level redirect back to us.
    sameSite: "lax",
    path: "/api/onenote",
    maxAge: 600,
  });
  return res;
}
