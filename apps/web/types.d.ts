// The Discord account id we put on the session in auth.ts — the key that maps a web visitor
// to their Hearth User (and therefore their characters and permissions).
import "next-auth";

declare module "next-auth" {
  interface Session {
    discordUserId: string | null;
  }
}
