/**
 * Data Retention Service
 *
 * Soft-delete pattern with a 30-day recovery window. When a merchant
 * uninstalls the app, their recoverable data (knowledge base, conversations)
 * is marked as deleted but kept in the DB. If they reinstall within 30 days,
 * everything is restored. After 30 days, rows are hard-deleted on the next
 * opportunistic purge.
 *
 * Security-sensitive data (Session, CustomerToken, CustomerAccountUrls) is
 * always hard-deleted immediately — those are not recoverable by design.
 *
 * Public API:
 *   softDeleteShopData(shop)       → called from APP_UNINSTALLED webhook
 *   restoreShopData(shop)          → called from app.jsx loader on app open
 *   purgeExpiredSoftDeletes()      → called opportunistically from app.jsx loader
 *   isWithinRetentionPeriod(date)  → helper for UI banners
 */
import prisma from "../db.server";

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Marks a shop's recoverable data as deleted. Conversations are matched by
 * shopDomain (the myshopify domain, stored in Conversation.shopDomain).
 *
 * Returns a summary of affected rows.
 */
export async function softDeleteShopData(shop) {
  if (!shop) return { syncState: 0, conversations: 0 };

  const now = new Date();

  // Soft-delete the ShopSyncState row (even if already soft-deleted, this
  // refreshes the timestamp — last uninstall wins).
  let syncStateCount = 0;
  const state = await prisma.shopSyncState.findUnique({ where: { shop } });
  if (state) {
    await prisma.shopSyncState.update({
      where: { shop },
      data: { deletedAt: now },
    });
    syncStateCount = 1;
  }

  // Soft-delete matching conversations using the stable myshopify domain.
  // This works regardless of whether the merchant changed their custom
  // domain since the conversations were created.
  const result = await prisma.conversation.updateMany({
    where: { shopDomain: shop, deletedAt: null },
    data: { deletedAt: now },
  });
  const conversationCount = result.count;

  return { syncState: syncStateCount, conversations: conversationCount };
}

/**
 * Restores soft-deleted data for a shop if it's within the retention window.
 * Called from app.jsx loader when the merchant re-opens the app after a
 * previous uninstall.
 *
 * Returns:
 *   { restored: true,  age: <days>, syncState: 1, conversations: N }
 *   { restored: false, reason: "no_soft_deleted_data" }
 *   { restored: false, reason: "expired", age: <days> }
 */
export async function restoreShopData(shop) {
  if (!shop) return { restored: false, reason: "missing_shop" };

  // Look for a soft-deleted ShopSyncState for this shop.
  const state = await prisma.shopSyncState.findUnique({ where: { shop } });
  if (!state || !state.deletedAt) {
    return { restored: false, reason: "no_soft_deleted_data" };
  }

  const ageMs = Date.now() - state.deletedAt.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  if (ageMs > RETENTION_MS) {
    // Outside the retention window — leave it for the purge job
    return { restored: false, reason: "expired", age: ageDays };
  }

  // Restore the ShopSyncState
  await prisma.shopSyncState.update({
    where: { shop },
    data: { deletedAt: null },
  });

  // Restore matching conversations using the stable myshopify domain.
  const result = await prisma.conversation.updateMany({
    where: { shopDomain: shop },
    data: { deletedAt: null },
  });
  const conversationCount = result.count;

  return {
    restored: true,
    age: ageDays,
    syncState: 1,
    conversations: conversationCount,
  };
}

/**
 * Hard-deletes any rows whose deletedAt timestamp is older than the retention
 * window. Called opportunistically from the app.jsx loader — no cron job.
 *
 * Conversations cascade-delete their Messages via Prisma onDelete: Cascade.
 */
export async function purgeExpiredSoftDeletes() {
  const cutoff = new Date(Date.now() - RETENTION_MS);

  const [syncStateResult, conversationResult] = await Promise.all([
    prisma.shopSyncState.deleteMany({
      where: { deletedAt: { lt: cutoff } },
    }),
    prisma.conversation.deleteMany({
      where: { deletedAt: { lt: cutoff } },
    }),
  ]);

  const total = syncStateResult.count + conversationResult.count;
  if (total > 0) {
    console.log(
      `[data-retention] purged ${syncStateResult.count} ShopSyncState + ${conversationResult.count} Conversation rows past retention`
    );
  }
  return {
    syncState: syncStateResult.count,
    conversations: conversationResult.count,
  };
}

/**
 * Helper for UI: returns true if a deletedAt timestamp is still within the
 * retention window (i.e. still recoverable).
 */
export function isWithinRetentionPeriod(deletedAt) {
  if (!deletedAt) return true; // not deleted at all
  return Date.now() - new Date(deletedAt).getTime() < RETENTION_MS;
}

export default {
  softDeleteShopData,
  restoreShopData,
  purgeExpiredSoftDeletes,
  isWithinRetentionPeriod,
  RETENTION_DAYS,
};
