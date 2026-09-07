// Auth.js — Discord login only, because a Hearth account IS a Discord account: the bot already
// links people by `User.discordUserId`, so signing in on the web resolves to the exact same
// person and the exact same permissions.
//
// Deliberately no database adapter. Sessions are JWTs carrying the Discord id, which we map to
// our existing User — so the web needs none of Auth.js's own tables, and there is one identity
// model across both surfaces rather than two that can drift.

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

// The OAuth app and the bot are the SAME Discord application, so the client id is just the
// bot's — default to it rather than making anyone keep two copies of one value in sync.
// A missing id or secret otherwise fails deep inside Discord's authorize endpoint with an
// opaque message, so say so here instead.
const DISCORD_ID =
  process.env.AUTH_DISCORD_ID || process.env.DISCORD_CLIENT_ID || "";
const DISCORD_SECRET = process.env.AUTH_DISCORD_SECRET || "";
if (!DISCORD_ID || !DISCORD_SECRET) {
  console.error(
    "[auth] Discord login is not configured — set AUTH_DISCORD_SECRET (and AUTH_DISCORD_ID, or DISCORD_CLIENT_ID) in .env. Find the secret at Developer Portal → your app → OAuth2 → Client Secret.",
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Discord({
      clientId: DISCORD_ID,
      clientSecret: DISCORD_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Stash the Discord account id on the token at sign-in; it's the only identity we need.
    jwt({ token, profile }) {
      if (profile?.id) token.discordUserId = String(profile.id);
      return token;
    },
    session({ session, token }) {
      session.discordUserId =
        typeof token.discordUserId === "string" ? token.discordUserId : null;
      return session;
    },
  },
});
