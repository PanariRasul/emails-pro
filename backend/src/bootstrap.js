// Shared start-up steps for every host (Render long-running server and Vercel serverless functions).
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { hashPassword } from "./routes/auth.js";

/** Create the first administrator from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD if there is none yet. */
export async function bootstrapAdmin() {
  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) return;
  const count = await prisma.user.count({ where: { role: "ADMIN" } });
  if (count > 0) return;
  if (config.bootstrapAdminPassword.length < 12) {
    logger.error(
      "BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters; admin not created",
    );
    return;
  }
  try {
    await prisma.user.create({
      data: {
        email: config.bootstrapAdminEmail.toLowerCase(),
        name: "Administrator",
        role: "ADMIN",
        passwordHash: await hashPassword(config.bootstrapAdminPassword),
      },
    });
    logger.info(
      { email: config.bootstrapAdminEmail },
      "bootstrap admin created — remove BOOTSTRAP_ADMIN_PASSWORD from the environment now",
    );
  } catch (err) {
    if (err.code !== "P2002") throw err; // another instance created it at the same moment
  }
}
