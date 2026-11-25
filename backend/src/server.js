import { config, validateConfig } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { prisma, closeDb, withDbRetry } from "./lib/prisma.js";
import { initRedis, closeRedis } from "./lib/redis.js";
import { createApp } from "./app.js";
import { startWorker, stopWorker } from "./worker/index.js";
import { bootstrapAdmin } from "./bootstrap.js";
import { smtpEgress } from "./services/egress.js";

validateConfig();

async function main() {
  await initRedis();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, version: config.version },
      `${config.appName} API listening`,
    );
  });
  smtpEgress().catch(() => {}); // warm the SMTP-egress check (Render Free blocks 25/465/587)
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // DB work after the port is open so Render sees the service as up even while Neon wakes.
  withDbRetry(
    async () => {
      await prisma.$connect();
      await bootstrapAdmin();
    },
    { attempts: 8, baseMs: 1000 },
  )
    .then(() => startWorker())
    .catch((err) => {
      logger.error(
        { err: err.message },
        "database not reachable at startup; worker will start once it is",
      );
      startWorker(); // the worker loop itself backs off until the DB is available
    });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down gracefully");
    const force = setTimeout(() => {
      logger.error("forced exit after timeout");
      process.exit(1);
    }, 28_000);
    force.unref();
    server.close();
    await stopWorker(20_000);
    await closeRedis();
    await closeDb();
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) =>
    logger.error(
      { err: err?.message, stack: err?.stack },
      "unhandled rejection",
    ),
  );
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception");
    shutdown("uncaughtException");
  });
}

main();
