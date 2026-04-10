import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { maybeSyncShopKnowledge } from "../services/shop-sync.server";
import { invalidateShopKnowledge } from "../services/shop-knowledge.server";

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
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      // The shop metafield is auto-deleted by Shopify on uninstall. We just
      // clean up the local mirror and sync state.
      await db.shopSyncState.deleteMany({ where: { shop } }).catch(() => {});
      invalidateShopKnowledge(shop);
      break;

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
