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
import { scrapeStorefront, mergeScrapedContent } from "./storefront-scraper.server";

const MAX_KNOWLEDGE_BYTES = 4 * 1024 * 1024; // 4 MB (metafield hard limit ~5 MB)
const MAX_PRODUCTS = 500;
const MAX_PAGES = 50;
const MAX_COLLECTIONS = 50;
const DESCRIPTION_MAX_CHARS = 2000;
const PAGE_BODY_MAX_CHARS = 3000;
const SCRAPED_CONTENT_MAX_CHARS = 1500;
const METAFIELD_VALUE_MAX_CHARS = 300;

// Shopify Admin GraphQL 2025-10+ removed shop.refundPolicy/shippingPolicy/...
// Policies are now exposed via shop.shopPolicies[] { type body url title }.
// Type is an enum: REFUND_POLICY, SHIPPING_POLICY, PRIVACY_POLICY,
// TERMS_OF_SERVICE, LEGAL_NOTICE, CONTACT_INFORMATION, SUBSCRIPTION_POLICY.
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
      shopPolicies {
        type
        title
        body
        url
      }
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
          descriptionHtml
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
          metafields(first: 15) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
          }
          collections(first: 5) {
            edges {
              node {
                handle
                title
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

const COLLECTIONS_QUERY = `#graphql
  query Collections {
    collections(first: 50) {
      edges {
        node {
          id
          handle
          title
          description
          productsCount { count }
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

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function compactMetafields(edges) {
  if (!Array.isArray(edges)) return [];
  return edges
    .map((e) => e?.node)
    .filter((n) => n && n.value)
    .map((n) => ({
      key: `${n.namespace}.${n.key}`,
      type: n.type,
      value: truncate(String(n.value), METAFIELD_VALUE_MAX_CHARS),
    }));
}

function compactProduct(node) {
  // Prefer plain description; fall back to HTML-stripped descriptionHtml if empty.
  let description = node.description || "";
  if (!description && node.descriptionHtml) {
    description = stripHtml(node.descriptionHtml);
  }

  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    description: truncate(description, DESCRIPTION_MAX_CHARS),
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
    metafields: compactMetafields(node.metafields?.edges),
    collections: (node.collections?.edges || []).map((e) => ({
      handle: e.node.handle,
      title: e.node.title,
    })),
  };
}

async function runQuery(admin, query, variables = {}) {
  let res;
  try {
    res = await admin.graphql(query, { variables });
  } catch (err) {
    // Shopify admin client sometimes throws a Response object (e.g. 302
    // redirect when the request context is lost). Surface that as a clear
    // error so callers don't just see "undefined".
    if (err instanceof Response) {
      throw new Error(`Admin GraphQL threw HTTP ${err.status} — likely session/context issue`);
    }
    throw err;
  }
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
      body: truncate(stripHtml(e.node.body), PAGE_BODY_MAX_CHARS),
    }));
  } catch (err) {
    console.warn("fetchPages failed:", err.message);
    return [];
  }
}

async function fetchCollections(admin) {
  try {
    const data = await runQuery(admin, COLLECTIONS_QUERY);
    return (data?.collections?.edges || [])
      .slice(0, MAX_COLLECTIONS)
      .map((e) => ({
        handle: e.node.handle,
        title: e.node.title,
        description: truncate(e.node.description, 400),
        productCount: e.node.productsCount?.count ?? null,
      }));
  } catch (err) {
    console.warn("fetchCollections failed:", err.message);
    return [];
  }
}

async function fetchShopInfo(admin) {
  const data = await runQuery(admin, SHOP_QUERY);
  return data?.shop || null;
}

function extractPolicies(shopPolicies) {
  // shopPolicies is an array of { type, title, body, url }. Index them by
  // type enum so callers can access refund/shipping/privacy/terms by name.
  const byType = {};
  if (Array.isArray(shopPolicies)) {
    for (const p of shopPolicies) {
      if (!p?.type) continue;
      byType[p.type] = p;
    }
  }
  const get = (type) => byType[type] || null;
  const refund = get("REFUND_POLICY");
  const shipping = get("SHIPPING_POLICY");
  const privacy = get("PRIVACY_POLICY");
  const terms = get("TERMS_OF_SERVICE");
  const legal = get("LEGAL_NOTICE");
  const contact = get("CONTACT_INFORMATION");
  const subscription = get("SUBSCRIPTION_POLICY");

  return {
    refund: truncate(stripHtml(refund?.body), PAGE_BODY_MAX_CHARS),
    refundUrl: refund?.url || null,
    shipping: truncate(stripHtml(shipping?.body), PAGE_BODY_MAX_CHARS),
    shippingUrl: shipping?.url || null,
    privacy: truncate(stripHtml(privacy?.body), PAGE_BODY_MAX_CHARS),
    privacyUrl: privacy?.url || null,
    terms: truncate(stripHtml(terms?.body), PAGE_BODY_MAX_CHARS),
    termsUrl: terms?.url || null,
    legal: truncate(stripHtml(legal?.body), PAGE_BODY_MAX_CHARS),
    legalUrl: legal?.url || null,
    contact: truncate(stripHtml(contact?.body), PAGE_BODY_MAX_CHARS),
    contactUrl: contact?.url || null,
    subscription: truncate(stripHtml(subscription?.body), PAGE_BODY_MAX_CHARS),
    subscriptionUrl: subscription?.url || null,
  };
}

function buildKnowledge(shopInfo, products, pages, collections = []) {
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
    policies: shopInfo ? extractPolicies(shopInfo.shopPolicies) : {},
    pages,
    collections,
    products,
    productCount: products.length,
    scrapedPages: [],
  };
}

function shrinkIfTooBig(knowledge) {
  let json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Pass 1: drop scraped pages body (redundant with API data, lowest value)
  if (knowledge.scrapedPages?.length) {
    knowledge.scrapedPages = knowledge.scrapedPages.map((p) => ({
      ...p,
      content: truncate(p.content, 500),
    }));
    json = JSON.stringify(knowledge);
    if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;
  }

  // Pass 2: drop scraped content on products (redundant with description)
  knowledge.products = knowledge.products.map((p) => ({
    ...p,
    scrapedContent: undefined,
  }));
  json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Pass 3: drop variants + tighten descriptions
  knowledge.products = knowledge.products.map((p) => ({
    ...p,
    description: truncate(p.description, 400),
    variants: [],
    metafields: (p.metafields || []).slice(0, 5),
  }));
  json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Pass 4: truncate product list
  knowledge.products = knowledge.products.slice(0, 200);
  knowledge.productCount = knowledge.products.length;
  json = JSON.stringify(knowledge);
  if (Buffer.byteLength(json, "utf8") <= MAX_KNOWLEDGE_BYTES) return json;

  // Pass 5: drop pages bodies entirely
  knowledge.pages = knowledge.pages.map((p) => ({ ...p, body: "" }));
  knowledge.scrapedPages = [];
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
    const [shopInfo, products, pages, collections] = await Promise.all([
      fetchShopInfo(admin),
      fetchAllProducts(admin),
      fetchPages(admin),
      fetchCollections(admin),
    ]);

    if (!shopInfo?.id) {
      throw new Error("Failed to fetch shop info (no shop id returned)");
    }

    const knowledge = buildKnowledge(shopInfo, products, pages, collections);

    // Phase 1.5 — Storefront scraping fallback. Visits the merchant's public
    // pages via sitemap.xml and captures text that the Admin API may miss
    // (theme sections with hard-coded info, app widgets, FAQ accordions, etc.).
    // If anything fails, we continue with API-only data — no regression.
    const storefrontUrl = shopInfo.primaryDomain?.url;
    if (storefrontUrl) {
      try {
        const scraped = await scrapeStorefront(storefrontUrl, {
          maxPages: 300,
          concurrency: 5,
          timeoutMs: 10_000,
        });
        mergeScrapedContent(knowledge, scraped, { maxCharsPerPage: SCRAPED_CONTENT_MAX_CHARS });
        console.log(
          `[shop-sync] ${shop}: scraped ${scraped.pages.length} storefront pages`
        );
      } catch (err) {
        console.warn(
          `[shop-sync] ${shop}: storefront scrape failed (continuing without):`,
          err.message
        );
      }
    }

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
