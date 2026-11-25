// Vercel (serverless) entry. Vercel runs this file's handler per request; there is no long-running process,
// so the background worker does not run here. Sending, reply sync and maintenance run when
// GET /api/cron/tick is called (Vercel Cron or an external scheduler — see README "Hosting on Vercel").
import { config, validateConfig } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { withDbRetry } from "./lib/prisma.js";
import { initRedis } from "./lib/redis.js";
import { createApp } from "./app.js";
import { bootstrapAdmin } from "./bootstrap.js";

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      validateConfig();
      await initRedis();
      const app = createApp();
      // Create the first admin before serving (only does work while BOOTSTRAP_ADMIN_* is set and no admin exists),
      // so the very first login after a deploy can't race it. A database outage doesn't stop the API from starting.
      await withDbRetry(() => bootstrapAdmin(), {
        attempts: 4,
        baseMs: 1000,
      }).catch((err) =>
        logger.error({ err: err.message }, "bootstrap admin failed"),
      );
      logger.info(
        { version: config.version, host: "vercel" },
        `${config.appName} API ready (serverless)`,
      );
      return app;
    })().catch((err) => {
      appPromise = null; // try again on the next request
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    logger.error({ err: err.message }, "API failed to start");
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          code: "STARTUP_FAILED",
          message:
            "The API could not start. Check the environment variables in Vercel (see the function logs).",
        },
      }),
    );
    return;
  }
  app(req, res);
}
