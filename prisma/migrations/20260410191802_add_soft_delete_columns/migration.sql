-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "ShopSyncState" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Conversation_shopHost_deletedAt_idx" ON "Conversation"("shopHost", "deletedAt");

-- CreateIndex
CREATE INDEX "Conversation_deletedAt_idx" ON "Conversation"("deletedAt");

-- CreateIndex
CREATE INDEX "ShopSyncState_deletedAt_idx" ON "ShopSyncState"("deletedAt");
