-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "shopHost" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_shopHost_idx" ON "Conversation"("shopHost");
