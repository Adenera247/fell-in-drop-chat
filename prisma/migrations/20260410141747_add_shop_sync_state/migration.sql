-- CreateTable
CREATE TABLE "ShopSyncState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "primaryHost" TEXT,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "knowledgeSize" INTEGER,
    "productCount" INTEGER,
    "knowledgeJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSyncState_primaryHost_key" ON "ShopSyncState"("primaryHost");
