import { aiRouter } from "./routes/ai.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import {
  errorHandler,
  notFoundHandler,
  requestTimeout,
} from "./middleware/common.js";
import publicRoutes from "./routes/public.js";
import authRoutes from "./routes/auth.js";
import accountRoutes, { oauthRouter } from "./routes/accounts.js";
import campaignRoutes from "./routes/campaigns.js";
import {
  listsRouter,
  pitchesRouter,
  suppressionsRouter,
} from "./routes/content.js";
import {
  inboxRouter,
  notificationsRouter,
  reportsRouter,
} from "./routes/inbox.js";
import adminRoutes from "./routes/admin.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of the service

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "form-action": ["'self'"],
          "img-src": ["'self'", "data:"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" }, // tracking pixel is loaded by mail clients
    }),
  );

  // Public (tracking/unsubscribe/health) — registered before CORS so mail clients & probes are never blocked.
  app.use(publicRoutes);

  app.use(
    "/api",
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // same-origin (Render rewrite) or server-to-server
        const o = origin.replace(/\/$/, "");
        return cb(null, config.corsOrigins.includes(o));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      maxAge: 600,
    }),
  );

  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(requestTimeout);

  // Lightweight access log (skip noisy health probes).
  app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/api/health") return next();
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > 1500 || res.statusCode >= 500) {
        logger.warn(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Math.round(ms),
            userId: req.user?.id,
          },
          "slow or failed request",
        );
      } else {
        logger.debug(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Math.round(ms),
          },
          "request",
        );
      }
    });
    return next();
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/oauth", oauthRouter);
  app.use("/api/smtp-accounts", accountRoutes);
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/pitches", pitchesRouter);
  app.use("/api/lists", listsRouter);
  app.use("/api/suppressions", suppressionsRouter);
  app.use("/api/inbox", inboxRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/admin", adminRoutes);

  app.get("/", (_req, res) =>
    res.json({
      app: config.appName,
      version: config.version,
      docs: "/health, /ready",
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
