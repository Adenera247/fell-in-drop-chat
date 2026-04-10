/**
 * Shop Knowledge Reader
 *
 * Reads the compact knowledge base for a given shop from the local
 * Prisma mirror (ShopSyncState.knowledgeJson). Maintains an in-memory
 * LRU cache so we don't re-parse the JSON on every chat message.
 *
 * Source of truth is the Shopify shop metafield ($app:claude_chat_bot.knowledge_base),
 * but the public /chat route has no admin client — the local mirror is what it reads.
 */
import prisma from "../db.server";
import { normalizeHost } from "./shop-identity.server";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX = 500; // active shops cached in memory

// Simple LRU with TTL (tiny, avoids lru-cache dependency)
class TTLCache {
  constructor(max, ttl) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    if (this.map.size > this.max) {
      // drop oldest
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  delete(key) {
    this.map.delete(key);
  }
}

const cache = new TTLCache(CACHE_MAX, CACHE_TTL_MS);

/**
 * Get the knowledge base for a shop.
 * Accepts either the myshopify domain (foo.myshopify.com) or the public
 * storefront host (foo.com). Uses strict findUnique lookups on indexed
 * unique fields so one host resolves to at most one shop — never
 * ambiguous across tenants.
 *
 * @param {string} hostOrShop - Shop hostname or myshopify domain
 * @returns {Promise<Object|null>} Parsed knowledge object or null if not synced yet
 */
export async function getShopKnowledge(hostOrShop) {
  const key = normalizeHost(hostOrShop);
  if (!key) return null;

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    // Strict: check primaryHost first, then the myshopify shop domain.
    // Both fields are unique (primaryHost via @unique, shop via @id), so
    // each call returns at most ONE row. Soft-deleted rows are excluded —
    // we never serve a knowledge base for a shop that has uninstalled.
    let state = await prisma.shopSyncState.findUnique({ where: { primaryHost: key } });
    if (state && state.deletedAt) state = null;
    if (!state) {
      state = await prisma.shopSyncState.findUnique({ where: { shop: key } });
      if (state && state.deletedAt) state = null;
    }

    if (!state?.knowledgeJson) {
      cache.set(key, null);
      return null;
    }
    const parsed = JSON.parse(state.knowledgeJson);
    cache.set(key, parsed);
    return parsed;
  } catch (err) {
    console.error(`[shop-knowledge] read failed for ${key}:`, err.message);
    return null;
  }
}

export function invalidateShopKnowledge(hostOrShop) {
  const key = normalizeHost(hostOrShop);
  if (key) cache.delete(key);
}

export default { getShopKnowledge, invalidateShopKnowledge };
