// The single Prisma client for the whole monorepo — bot / web / worker all
// import `prisma` from here. Prisma 7 has no binary engine; it connects through
// the pg driver adapter, which we point at the pooled Supabase URL.
//
// The pg adapter does NOT cache prepared statements by default, which is exactly
// what Supabase's transaction pooler (pgbouncer) needs — so DATABASE_URL is the
// pooled :6543 connection.

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

// One client per copy of this module, shared across hot reloads. A Next.js server can load more
// than one copy (in development each page and route is compiled on its own), and a raw query only
// accepts SQL fragments (Prisma.sql) made by the copy that made its client: given another copy's
// client, `${fragment}` is sent as a value and Postgres rejects it ("invalid input syntax for
// type boolean"). So clients are kept per copy, keyed by that copy's Sql class.
const globalForPrisma = globalThis as unknown as {
  prismaClients?: Map<unknown, PrismaClient>;
};

/** Build (or reuse) the client. Called on first *use*, never at import. */
function getClient(): PrismaClient {
  const clients = (globalForPrisma.prismaClients ??= new Map());
  const existing = clients.get(Prisma.Sql);
  if (existing) return existing;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — the database client cannot be created.",
    );
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  // Reuse it across hot-reloads (dev) and warm serverless invocations.
  clients.set(Prisma.Sql, client);
  return client;
}

/**
 * Lazily-initialized singleton Prisma client. Initialization happens on first
 * property access, NOT at import time — so importing `@hearth/db` for types or
 * enum values never requires DATABASE_URL or opens a connection.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// Re-export generated types, enums, the PrismaClient class, and the Prisma
// namespace so consumers do: import { prisma, type KnowledgeUnit } from "@hearth/db"
export * from "./generated/prisma/client.js";
