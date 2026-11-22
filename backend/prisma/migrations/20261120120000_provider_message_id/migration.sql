-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "providerMessageId" TEXT;

-- CreateIndex
CREATE INDEX "CampaignRecipient_providerMessageId_idx" ON "CampaignRecipient"("providerMessageId");
