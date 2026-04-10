/**
 * Shop Identity Service
 *
 * Centralizes how we identify and isolate shops in requests to the public
 * /chat route. This is the ONLY file that should decide which shop a
 * chat request belongs to — keep the logic here so we don't drift.
 *
 * Isolation contract:
 *  - The stable identifier for a shop is its myshopify.com domain (stored
 *    in ShopSyncState.shop and in Conversation.shopDomain). It never
 *    changes for the life of the shop.
 *  - The public storefront domain (ShopSyncState.primaryHost) CAN change
 *    when the merchant migrates to a new custom domain, so we never use
 *    it as a primary key for conversations.
 *  - normalizeHost() produces a canonical form (lowercase, no www, no port).
 *  - resolveShopForRequest() returns a shop domain + (optional) state,
 *    or null if nothing can be resolved.
 *  - Conversations are tagged with shopDomain on first message;
 *    subsequent messages on the same conversation_id must come from the
 *    same shopDomain or they are rejected.
 */
import prisma from "../db.server";

/**
 * Canonical hostname: lowercase, strip "www.", strip port and trailing slashes.
 * Accepts raw hostnames or full URLs.
 */
export function normalizeHost(input) {
  if (!input) return null;
  let h = String(input).trim().toLowerCase();
  // Strip protocol if present
  h = h.replace(/^https?:\/\//, "");
  // Strip path / query / fragment
  h = h.split("/")[0].split("?")[0].split("#")[0];
  // Strip port
  h = h.split(":")[0];
  // Strip leading www.
  h = h.replace(/^www\./, "");
  // Strip trailing dot
  h = h.replace(/\.$/, "");
  return h || null;
}

/**
 * Resolves the authoritative shop for a chat request.
 *
 * Strategy (in priority order):
 *
 *  1. TRUSTED BODY — The merchant explicitly configures store_domain in the
 *     chat bubble theme editor with their .myshopify.com domain. When this
 *     value is present and matches a known ShopSyncState, we use it as the
 *     primary identifier — but we cross-validate with Origin to prevent
 *     spoofing: Origin must match either the myshopify domain itself or
 *     the registered primaryHost. This covers the normal flow where the
 *     browser sees the custom domain while the body carries the myshopify.
 *
 *  2. ORIGIN FALLBACK — If no valid storeDomain is provided, or validation
 *     failed, fall back to resolving by Origin alone. We try primaryHost
 *     first (custom domain) then shop (myshopify domain). This handles
 *     curl tests, misconfigured themes, and initial install flows.
 *
 *  3. UNMATCHED — If nothing in DB matches, return a best-effort shopDomain
 *     (storeDomain if it looks like a myshopify domain, else the Origin)
 *     with state=null. Callers can still tag the conversation with this
 *     value so ordering is consistent even before the first sync.
 *
 * Returns:
 *   { shopDomain: string, state: ShopSyncState | null } | null
 *
 * @param {Object} opts
 * @param {string|null} opts.origin - Origin header value
 * @param {string|null} opts.storeDomain - storeDomain from request body
 */
export async function resolveShopForRequest({ origin, storeDomain }) {
  const originHost = normalizeHost(origin);
  const storeDomainNormalized = normalizeHost(storeDomain);

  // --- Strategy 1: trusted body + Origin cross-validation ---
  if (storeDomainNormalized && storeDomainNormalized.endsWith(".myshopify.com")) {
    const state = await prisma.shopSyncState.findUnique({
      where: { shop: storeDomainNormalized },
    });
    if (state && !state.deletedAt) {
      // Cross-validate: Origin must match either the shop or primaryHost.
      // If originHost is missing (e.g. server-to-server call), we trust
      // storeDomain on its own — the merchant configured it explicitly.
      const originMatchesShop = originHost === state.shop;
      const originMatchesPrimary = state.primaryHost && originHost === state.primaryHost;
      if (!originHost || originMatchesShop || originMatchesPrimary) {
        return { shopDomain: state.shop, state };
      }
      console.warn(
        `[shop-identity] storeDomain (${storeDomainNormalized}) known but Origin (${originHost}) matches neither shop (${state.shop}) nor primaryHost (${state.primaryHost}) — rejecting body claim, falling back to Origin`
      );
      // Fall through — don't trust a mismatched body
    }
  }

  // --- Strategy 2: resolve by Origin alone ---
  if (originHost) {
    // Try primaryHost first (merchant's public custom domain)
    let state = await prisma.shopSyncState.findUnique({
      where: { primaryHost: originHost },
    });
    if (state && !state.deletedAt) {
      return { shopDomain: state.shop, state };
    }
    // Then try the myshopify shop domain
    state = await prisma.shopSyncState.findUnique({
      where: { shop: originHost },
    });
    if (state && !state.deletedAt) {
      return { shopDomain: state.shop, state };
    }
  }

  // --- Strategy 3: no DB match — best-effort identifier for conversation tagging ---
  // Prefer a myshopify-looking storeDomain, else the Origin, so that the
  // conversation can at least be tagged consistently even before the sync
  // has run. state is null so downstream code knows we have no config yet.
  let fallback = null;
  if (storeDomainNormalized?.endsWith(".myshopify.com")) {
    fallback = storeDomainNormalized;
  } else if (originHost) {
    fallback = originHost;
  } else if (storeDomainNormalized) {
    fallback = storeDomainNormalized;
  }

  if (fallback) {
    return { shopDomain: fallback, state: null };
  }

  return null;
}

/**
 * Enforces conversation ↔ shopDomain binding. If the conversation already
 * has a shopDomain, the incoming request must match it or we throw.
 *
 * On first message (no shopDomain yet), tags the conversation with the
 * resolved shopDomain. Also refuses to reuse soft-deleted conversations.
 *
 * @param {string} conversationId
 * @param {string} shopDomain - The myshopify domain (or fallback host)
 * @throws {Error} if the conversation belongs to a different shop
 */
export async function enforceConversationShop(conversationId, shopDomain) {
  if (!conversationId || !shopDomain) return;

  const existing = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { shopDomain: true, deletedAt: true },
  });

  if (!existing) {
    // Conversation will be created by saveMessage — we just pre-tag it.
    await prisma.conversation.upsert({
      where: { id: conversationId },
      create: { id: conversationId, shopDomain },
      update: { shopDomain, deletedAt: null },
    });
    return;
  }

  // Refuse to reuse a soft-deleted conversation — otherwise a leaked
  // conversation_id could be "revived" after an uninstall, bypassing the
  // merchant's intent. Treat it like a foreign conversation.
  if (existing.deletedAt) {
    const err = new Error(
      `Conversation ${conversationId} is soft-deleted, rejecting reuse from ${shopDomain}`
    );
    err.code = "SHOP_MISMATCH";
    throw err;
  }

  if (!existing.shopDomain) {
    // Legacy conversation (pre-isolation, or wiped-then-reused id) — tag it now.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { shopDomain },
    });
    return;
  }

  if (existing.shopDomain !== shopDomain) {
    const err = new Error(
      `Conversation ${conversationId} belongs to shop ${existing.shopDomain}, rejected request from ${shopDomain}`
    );
    err.code = "SHOP_MISMATCH";
    throw err;
  }
}

export default { normalizeHost, resolveShopForRequest, enforceConversationShop };
