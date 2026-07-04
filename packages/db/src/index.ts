// The single Prisma client for the whole monorepo — bot / web / worker all
// import `prisma` from here. Prisma 7 has no binary engine; it connects through
// the pg driver adapter, which we point at the pooled Supabase URL.
//
// The pg adapter does NOT cache prepared statements by default, which is exactly
// what Supabase's transaction pooler (pgbouncer) needs — so DATABASE_URL is the
// pooled :6543 connection.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — the database client cannot be created.",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse one client across hot-reloads (dev) and warm serverless invocations.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export generated types, enums, the PrismaClient class, and the Prisma
// namespace so consumers do: import { prisma, type KnowledgeUnit } from "@hearth/db"
export * from "./generated/prisma/client.js";
