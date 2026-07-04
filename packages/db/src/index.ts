// The single Prisma client for the whole monorepo — bot / web / worker all
// import `prisma` from here. Prisma 7 has no binary engine; it connects through
// the pg driver adapter, which we point at the pooled Supabase URL.
//
// The pg adapter does NOT cache prepared statements by default, which is exactly
// what Supabase's transaction pooler (pgbouncer) needs — so DATABASE_URL is the
// pooled :6543 connection.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Build (or reuse) the client. Called on first *use*, never at import. */
function getClient(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — the database client cannot be created.",
    );
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  // Reuse one client across hot-reloads (dev) and warm serverless invocations.
  globalForPrisma.prisma = client;
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
