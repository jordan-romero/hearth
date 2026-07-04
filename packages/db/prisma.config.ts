import { defineConfig, env } from "prisma/config";

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
    url: env("DIRECT_URL"),
  },
});
