import { existsSync } from "node:fs";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "./logger.js";

// Serverless hosts (Vercel) copy only the files they can see being used. Prisma opens its query compiler
// (a .wasm file) through a path built at runtime, so it would be left out. This static reference makes the
// bundler include it; it has no effect on Render or locally.
const QUERY_COMPILER_WASM = new URL(
  "../../node_modules/.prisma/client/query_compiler_bg.wasm",
  import.meta.url,
);
if (process.env.VERCEL && !existsSync(QUERY_COMPILER_WASM)) {
  logger.error(
    'Prisma query compiler (query_compiler_bg.wasm) is missing from the deployment — run "prisma generate" in the build',
  );
}

// Exactly one PrismaClient (and one small pg Pool) per process.
// DATABASE_URL should be Neon's *pooled* connection string (host contains "-pooler").
// DB_POOL_MAX keeps us well under Neon Free connection limits.
const globalRef = globalThis;

function createClient() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.DB_POOL_MAX || "5", 10),
    idleTimeoutMillis: 30_000, // release idle connections so Neon can auto-suspend
    connectionTimeoutMillis: 20_000, // Neon cold start can take a few seconds
    keepAlive: true,
    allowExitOnIdle: false,
  });
  // Without this handler, an idle connection dropped by Neon (compute suspend) would crash the process.
  pool.on("error", (err) =>
    logger.warn({ err: err.message }, "idle database connection closed"),
  );
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [
      { level: "warn", emit: "event" },
      { level: "error", emit: "event" },
    ],
  });
  client.$on("warn", (e) =>
    logger.warn({ prisma: e.message }, "prisma warning"),
  );
  client.$on("error", (e) =>
    logger.error({ prisma: e.message }, "prisma error"),
  );
  return { client, pool };
}

if (!globalRef.__emailsPro) globalRef.__emailsPro = createClient();

export const prisma = globalRef.__emailsPro.client;
export const dbPool = globalRef.__emailsPro.pool;

// Errors that mean "database unreachable / waking up" (Neon cold start, network blip).
const TRANSIENT_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01",
  "57P03",
  "08006",
  "08001",
  "08003",
]);

export function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code) || TRANSIENT_CODES.has(err.cause?.code))
    return true;
  const name = err.constructor?.name || "";
  if (
    name === "PrismaClientInitializationError" ||
    name === "PrismaClientRustPanicError"
  )
    return true;
  const msg = `${err.message || ""} ${err.cause?.message || ""}`;
  return /Can't reach database|DatabaseNotReachable|Connection terminated|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection closed|timeout exceeded when trying to connect|Timed out fetching a new connection|the database system is starting up|terminating connection|Couldn't connect|compute.*(suspend|start)/i.test(
    msg,
  );
}

/** Retry a DB operation with exponential backoff + jitter (for cold starts). Only use for idempotent work. */
export async function withDbRetry(fn, { attempts = 4, baseMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || i === attempts - 1) throw err;
      const delay = Math.min(8000, baseMs * 2 ** i) * (0.5 + Math.random() / 2);
      logger.warn(
        { attempt: i + 1, delay: Math.round(delay) },
        "database unavailable, retrying",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function pingDb() {
  const t0 = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - t0;
}

export async function closeDb() {
  await prisma.$disconnect().catch(() => {});
  await dbPool.end().catch(() => {});
}
