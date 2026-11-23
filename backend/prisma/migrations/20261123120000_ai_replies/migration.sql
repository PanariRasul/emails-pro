-- AI assistant settings (Gemini free-tier limits), lead status on replies, out-of-office detection.

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('INTERESTED', 'MEETING', 'NOT_INTERESTED', 'WRONG_PERSON', 'OUT_OF_OFFICE', 'OTHER');

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "aiDailyLimit" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "aiPerMinute" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "aiReplyAssist" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "aiUserDailyLimit" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "leadStatus" "LeadStatus",
ADD COLUMN     "leadStatusAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "isAutoReply" BOOLEAN NOT NULL DEFAULT false;