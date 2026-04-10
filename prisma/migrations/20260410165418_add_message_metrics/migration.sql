-- AlterTable
ALTER TABLE "Message" ADD COLUMN "fallbackUsed" BOOLEAN DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "tokensUsed" INTEGER;

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
