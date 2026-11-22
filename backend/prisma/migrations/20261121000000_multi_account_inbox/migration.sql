-- AlterTable
ALTER TABLE "SystemSettings" ALTER COLUMN "imapSyncIntervalMin" SET DEFAULT 3;

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "groupName" TEXT,
ADD COLUMN     "imapSpamLastUid" INTEGER,
ADD COLUMN     "imapSpamPath" TEXT,
ADD COLUMN     "imapSpamUidValidity" BIGINT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "accountPacing" JSONB;

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "folder" TEXT NOT NULL DEFAULT 'INBOX';

-- Data: existing fresh campaigns use their single account as the account list.
UPDATE "Campaign" SET "accountIds" = ARRAY["accountId"] WHERE "accountId" IS NOT NULL AND cardinality("accountIds") = 0;

-- Data: every recipient carries its sending mailbox explicitly.
UPDATE "CampaignRecipient" r SET "accountId" = c."accountId"
  FROM "Campaign" c WHERE r."campaignId" = c."id" AND r."accountId" IS NULL AND c."accountId" IS NOT NULL;

-- Data: check mailboxes for replies every 3 minutes instead of 10 (unless the admin chose something else).
UPDATE "SystemSettings" SET "imapSyncIntervalMin" = 3 WHERE "imapSyncIntervalMin" = 10;

-- Inbox list query (non-deleted messages per owner).
CREATE INDEX "EmailMessage_ownerId_deletedAt_receivedAt_idx" ON "EmailMessage"("ownerId", "deletedAt", "receivedAt");