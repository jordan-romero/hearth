// The OneNote sign-in round trip. The `state` we send Microsoft is also kept in a short-lived,
// httpOnly cookie with the campaign it's for; the callback only proceeds when the two match, so
// a forged callback can't attach someone else's Microsoft account to a campaign.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_COOKIE = "hearth_onenote_state";

/** Where Microsoft sends the DM back to. Must be registered on the Azure app exactly. */
export function oneNoteRedirectUri(origin: string): string {
  return `${process.env.AUTH_URL ?? origin}/api/onenote/callback`;
}

export function newState(campaignId: string): {
  state: string;
  cookie: string;
} {
  const state = randomBytes(24).toString("base64url");
  return { state, cookie: `${state}.${campaignId}` };
}

/** The campaign a callback is for, or null if its state doesn't match the cookie. */
export function campaignForState(
  cookie: string | undefined,
  state: string | null,
): string | null {
  if (!cookie || !state) return null;
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const expected = Buffer.from(cookie.slice(0, dot));
  const got = Buffer.from(state);
  if (expected.length !== got.length || !timingSafeEqual(expected, got))
    return null;
  return cookie.slice(dot + 1) || null;
}
