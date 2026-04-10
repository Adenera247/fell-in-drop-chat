import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { maybeSyncShopKnowledge } from "../services/shop-sync.server";
import { invalidateShopKnowledge } from "../services/shop-knowledge.server";
import { softDeleteShopData, RETENTION_DAYS } from "../services/data-retention.server";

async function triggerResync(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    // 30s debounce inside maybeSyncShopKnowledge handles webhook bursts
    await maybeSyncShopKnowledge(admin, shop);
    invalidateShopKnowledge(shop);
  } catch (err) {
    console.error(`[webhooks] resync failed for ${shop}:`, err.message);
  }
}

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "APP_UNINSTALLED": {
      // Security-sensitive data is ALWAYS hard-deleted immediately — OAuth
      // tokens cannot (and should not) be recovered on reinstall.
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      // CustomerToken rows are linked to conversations, not shop, so they
      // would linger. We clean them up along with the session: find all
      // conversations belonging to this shop (via the stable myshopify
      // domain) and wipe their customer tokens. Done BEFORE the soft-delete
      // so we can still query the conversations by their active state.
      try {
        const conversationIds = await db.conversation
          .findMany({
            where: { shopDomain: shop },
            select: { id: true },
          })
          .then((rows) => rows.map((r) => r.id));
        if (conversationIds.length) {
          await db.customerToken.deleteMany({
            where: { conversationId: { in: conversationIds } },
          });
          await db.customerAccountUrls.deleteMany({
            where: { conversationId: { in: conversationIds } },
          });
        }
      } catch (err) {
        console.warn(`[webhooks] ${shop}: customer-token cleanup failed:`, err.message);
      }

      // Recoverable data is soft-deleted. The shop metafield on Shopify is
      // auto-deleted by Shopify, but our local mirror + conversations are
      // preserved for RETENTION_DAYS so the merchant can reinstall and
      // restore everything without re-config.
      try {
        const counts = await softDeleteShopData(shop);
        console.log(
          `[webhooks] ${shop}: soft-deleted ${counts.syncState} ShopSyncState + ${counts.conversations} conversations (recoverable ${RETENTION_DAYS}d)`
        );
      } catch (err) {
        console.error(`[webhooks] ${shop}: soft-delete failed:`, err.message);
      }

      invalidateShopKnowledge(shop);
      break;
    }

    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE":
    case "PRODUCTS_DELETE":
    case "COLLECTIONS_UPDATE":
    case "SHOP_UPDATE":
      // Fire-and-forget — webhook should return fast
      triggerResync(shop);
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
