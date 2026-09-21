import { defineConfig } from "prisma/config";

// Prisma 7 CLI config. Connection URLs moved here from schema.prisma.
// Env vars are injected by the package scripts via `dotenv -e ../../.env`
// (see package.json), so they resolve to the repo-root .env.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // The CLI (migrate / introspect) is the ONLY consumer of this URL, and it
    // needs the DIRECT connection — pgbouncer's transaction pooler can't hold
    // the session-level locks migrations take. The runtime client connects
    // separately via the pg adapter using the pooled DATABASE_URL (see src/index.ts).
    //
    // Read leniently on purpose. `prisma generate` loads this file and never opens a
    // connection, so demanding the variable here failed every build that only generates the
    // client — which is every Vercel preview, where the database URLs aren't set. A command
    // that really does need a database fails on this placeholder, and the placeholder says
    // which variable to set.
    url: process.env.DIRECT_URL ?? "postgresql://DIRECT_URL-is-not-set",
  },
});
