-- Warm-up is now a percentage ramp: day 1 = warmupStartPercent of the account's normal daily limit,
-- rising evenly to 100% on day warmupDays (defaults: 20% → 100% over 10 days).
-- The old fixed-number settings (start volume + daily increase) are replaced.

-- AlterTable
ALTER TABLE "SystemSettings" DROP COLUMN "warmupDailyIncrement",
DROP COLUMN "warmupInitialDaily",
ADD COLUMN     "warmupDays" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "warmupStartPercent" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "EmailAccount" DROP COLUMN "warmupDailyIncrement",
DROP COLUMN "warmupInitialDaily",
ADD COLUMN     "warmupDays" INTEGER,
ADD COLUMN     "warmupStartPercent" INTEGER;