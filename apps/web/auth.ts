// Auth.js — Discord login only, because a Hearth account IS a Discord account: the bot already
// links people by `User.discordUserId`, so signing in on the web resolves to the exact same
// person and the exact same permissions.
//
// Deliberately no database adapter. Sessions are JWTs carrying the Discord id, which we map to
// our existing User — so the web needs none of Auth.js's own tables, and there is one identity
// model across both surfaces rather than two that can drift.

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Discord({
      clientId: process.env.AUTH_DISCORD_ID,
      clientSecret: process.env.AUTH_DISCORD_SECRET,
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
