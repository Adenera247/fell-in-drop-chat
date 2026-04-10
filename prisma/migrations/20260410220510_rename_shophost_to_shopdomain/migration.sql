/*
  Warnings:

  - You are about to drop the column `shopHost` on the `Conversation` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Conversation" ("createdAt", "deletedAt", "id", "updatedAt") SELECT "createdAt", "deletedAt", "id", "updatedAt" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE INDEX "Conversation_shopDomain_idx" ON "Conversation"("shopDomain");
CREATE INDEX "Conversation_shopDomain_deletedAt_idx" ON "Conversation"("shopDomain", "deletedAt");
CREATE INDEX "Conversation_deletedAt_idx" ON "Conversation"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
