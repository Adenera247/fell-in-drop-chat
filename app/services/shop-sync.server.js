/**
 * Shop Sync Service
 *
 * Pulls the merchant's catalog, pages, policies and shop info via Shopify
 * Admin GraphQL, then writes a compact JSON knowledge base into a shop
 * metafield ($app:claude_chat_bot.knowledge_base). Shopify auto-deletes
 * this metafield when the app is uninstalled, so nothing persists centrally.
 *
 * A compact mirror is also written into the local DB (ShopSyncState.knowledgeJson)
 * so the public /chat route — which has no authenticated admin client — can
 * read the knowledge base without an extra Admin API round-trip.
 */
import prisma from "../db.server";
import { normalizeHost } from "./shop-identity.server";

const MAX_KNOWLEDGE_BYTES = 4 * 1024 * 1024; // 4 MB (metafield hard limit ~5 MB)
const MAX_PRODUCTS = 500;
const MAX_PAGES = 50;
const DESCRIPTION_MAX_CHARS = 500;
const PAGE_BODY_MAX_CHARS = 2000;

const SHOP_QUERY = `#graphql
  query ShopInfo {
    shop {
      id
      name
      email
      myshopifyDomain
      primaryDomain { url host }
      currencyCode
      ianaTimezone
      contactEmail
      billingAddress {
        country
        city
      }
      shipsToCountries
      refundPolicy { body url }
      shippingPolicy { body url }
      privacyPolicy { body url }
      termsOfService { body url }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query Products($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          description
          vendor
          productType
          tags
          status
          onlineStoreUrl
          featuredImage { url altText }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          totalInventory
          variants(first: 5) {
            edges {
              node {
                id
                title
                price
                sku
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`;

const PAGES_QUERY = `#graphql
  query Pages {
    pages(first: 50) {
      edges {
        node {
          id
          handle
          title
          body
        }
      }
    }
  }
`;

function truncate(str, max) {
  if (!str) return "";
  const clean = String(str).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function compactProduct(node) {
  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    description: truncate(node.description, DESCRIPTION_MAX_CHARS),
    vendor: node.vendor || null,
    productType: node.productType || null,
    tags: node.tags || [],
    status: node.status,
    url: node.onlineStoreUrl || null,
    image: node.featuredImage?.url || null,
    priceMin: node.priceRangeV2?.minVariantPrice?.amount || null,
    priceMax: node.priceRangeV2?.maxVariantPrice?.amount || null,
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode || null,
    totalInventory: node.totalInventory ?? null,
    variants: (node.variants?.edges || []).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      price: e.node.price,
      sku: e.node.sku,
      available: e.node.availableForSale,
    })),
  };
}

async function runQuery(admin, query, variables = {}) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function fetchAllProducts(admin) {
  const out = [];
  let cursor = null;
  while (out.length < MAX_PRODUCTS) {
    const data = await runQuery(admin, PRODUCTS_QUERY, { cursor });
    const edges = data?.products?.edges || [];
    for (const e of edges) out.push(compactProduct(e.node));
    if (!data?.products?.pageInfo?.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out.slice(0, MAX_PRODUCTS);
}

async function fetchPages(admin) {
  try {
    const data = await runQuery(admin, PAGES_QUERY);
    return (data?.pages?.edges || []).slice(0, MAX_PAGES).map((e) => ({
      handle: e.node.handle,
      title: e.node.title,
      body: truncate(e.node.body, PAGE_BODY_MAX_CHARS),
    }));
  } catch (err) {
    console.warn("fetchPages failed:", err.message);
    return [];
  }
}

async function fetchShopInfo(admin) {
  const data = await runQuery(admin, SHOP_QUERY);
  return data?.shop || null;
}

function buildKnowledge(shopInfo, products, pages) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    shop: shopInfo
      ? {
          id: shopInfo.id,
          name: shopInfo.name,
          email: shopInfo.email || shopInfo.contactEmail,
          domain: shopInfo.primaryDomain?.host,
          url: shopInfo.primaryDomain?.url,
          currency: shopInfo.currencyCode,
          timezone: shopInfo.ianaTimezone,
          country: shopInfo.billingAddress?.country,
          city: shopInfo.billingAddress?.city,
          shipsToCountries: shopInfo.shipsToCountries || [],
        }
      : null,
    policies: shopInfo
      ? {
          refund: truncate(shopInfo.refundPolicy?.body, PAGE_BODY_MAX_CHARS),
          refundUrl: shopInfo.refundPolicy?.url || null,
          shipping: truncate(shopInfo.shippingPolicy?.body, PAGE_BODY_MAX_CHARS),
          shippingUrl: shopInfo.shippingPolicy?.url || null,
          privacy: truncate(shopInfo.privacyPolicy?.body, PAGE_BODY_MAX_CHARS),
          privacyUrl: shopInfo.privacyPolicy?.url || null,
          terms: truncate(shopInfo.termsOfService?.body, PAGE_BODY_MAX_CHARS),
          termsUrl: shopInfo.termsOfService?.url || null,
        }
      : {},
    pages,
    products,
    productCount: products.length,
  };
}

function shrinkIfTooBig(knowledge) {
  let json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // First pass: drop variants + tighten descriptions
  knowledge.products = knowledge.products.map((p) => ({
    ...p,
    description: truncate(p.description, 200),
    variants: [],
  }));
  json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Second pass: truncate product list
  knowledge.products = knowledge.products.slice(0, 200);
  knowledge.productCount = knowledge.products.length;
  json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Last resort: drop pages bodies
  knowledge.pages = knowledge.pages.map((p) => ({ ...p, body: "" }));
  return JSON.stringify(knowledge);
}

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message code }
    }
  }
`;

async function writeMetafield(admin, shopId, json) {
  const data = await runQuery(admin, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: shopId,
        namespace: "$app:claude_chat_bot",
        key: "knowledge_base",
        type: "json",
        value: json,
      },
    ],
  });
  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errors)}`);
  }
}

/**
 * Synchronizes the shop knowledge base.
 * @param {Object} admin - Authenticated Admin GraphQL client (from authenticate.admin)
 * @param {string} shop - Shop domain (e.g. mystore.myshopify.com)
 */
export async function syncShopKnowledge(admin, shop) {
  await prisma.shopSyncState.upsert({
    where: { shop },
    create: { shop, syncStatus: "syncing" },
    update: { syncStatus: "syncing", syncError: null },
  });

  try {
    const [shopInfo, products, pages] = await Promise.all([
      fetchShopInfo(admin),
      fetchAllProducts(admin),
      fetchPages(admin),
    ]);

    if (!shopInfo?.id) {
      throw new Error("Failed to fetch shop info (no shop id returned)");
    }

    const knowledge = buildKnowledge(shopInfo, products, pages);
    const json = shrinkIfTooBig(knowledge);

    await writeMetafield(admin, shopInfo.id, json);

    // The primary storefront host (e.g. zenovyra.com) is what the public
    // /chat route sees as Origin — we store it normalized so lookups match
    // regardless of casing or www prefix.
    const primaryHost = normalizeHost(shopInfo.primaryDomain?.host);

    await prisma.shopSyncState.update({
      where: { shop },
      data: {
        primaryHost,
        syncStatus: "success",
        syncError: null,
        lastSyncedAt: new Date(),
        knowledgeSize: Buffer.byteLength(json, "utf8"),
        productCount: products.length,
        knowledgeJson: json,
      },
    });

    console.log(
      `[shop-sync] ${shop}: synced ${products.length} products (${Buffer.byteLength(json, "utf8")} bytes)`
    );
    return { ok: true, productCount: products.length };
  } catch (err) {
    console.error(`[shop-sync] ${shop} failed:`, err);
    await prisma.shopSyncState.update({
      where: { shop },
      data: {
        syncStatus: "failed",
        syncError: err.message?.slice(0, 500) || "unknown",
      },
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Debounced trigger: skips if a sync is already running or was run in the last 30s.
 */
export async function maybeSyncShopKnowledge(admin, shop, { maxAgeMs = 30_000 } = {}) {
  const state = await prisma.shopSyncState.findUnique({ where: { shop } });
  if (state?.syncStatus === "syncing") return { skipped: true, reason: "in_progress" };
  if (
    state?.syncStatus === "success" &&
    state.lastSyncedAt &&
    Date.now() - state.lastSyncedAt.getTime() < maxAgeMs
  ) {
    return { skipped: true, reason: "recent" };
  }
  return syncShopKnowledge(admin, shop);
}

export default { syncShopKnowledge, maybeSyncShopKnowledge };
