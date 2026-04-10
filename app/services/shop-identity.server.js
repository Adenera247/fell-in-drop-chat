/**
 * Shop Identity Service
 *
 * Centralizes how we identify and isolate shops in requests to the public
 * /chat route. This is the ONLY file that should decide which shop a
 * chat request belongs to — keep the logic here so we don't drift.
 *
 * Isolation contract:
 *  - normalizeHost() produces a canonical form (lowercase, no www, no port).
 *  - resolveShopForRequest() returns ONE shop or null — never ambiguous.
 *  - Conversations are tagged with shopHost on first message; subsequent
 *    messages on the same conversation_id must come from the same shop or
 *    they are rejected.
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
 * Priority:
 *  1. The Origin header (CORS-enforced by the browser → trustworthy)
 *  2. The storeDomain from the body (merchant-configured in theme settings,
 *     but still client-side — only used as fallback when Origin is missing)
 *
 * We then look up the ShopSyncState by either:
 *  - shop (myshopify domain), or
 *  - primaryHost (the merchant's public domain),
 *
 * but using TWO separate findUnique calls instead of a single OR query —
 * this guarantees we never match two shops at once.
 *
 * @param {Object} opts
 * @param {string|null} opts.origin - Origin header value
 * @param {string|null} opts.storeDomain - storeDomain from request body
 * @returns {Promise<{host: string, state: Object}|null>}
 */
export async function resolveShopForRequest({ origin, storeDomain }) {
  // Canonical candidate list: Origin first (browser-enforced), then body.
  const candidates = [normalizeHost(origin), normalizeHost(storeDomain)].filter(Boolean);

  if (candidates.length === 0) return null;

  // Log divergence — a client sending mismatched Origin vs storeDomain is
  // suspicious and worth surfacing.
  if (candidates.length === 2 && candidates[0] !== candidates[1]) {
    console.warn(
      `[shop-identity] Origin (${candidates[0]}) differs from storeDomain (${candidates[1]}) — using Origin`
    );
  }

  for (const host of candidates) {
    // Try primaryHost match first (public domain like zenovyra.com)
    let state = await prisma.shopSyncState.findUnique({ where: { primaryHost: host } });
    if (state) return { host, state };

    // Then try the myshopify shop domain (e.g. mystore.myshopify.com)
    state = await prisma.shopSyncState.findUnique({ where: { shop: host } });
    if (state) return { host, state };
  }

  // No ShopSyncState yet (merchant hasn't opened the embed), but we still
  // need to return a shop host so we can tag the conversation. Use the
  // first candidate (Origin) as the authoritative host.
  return { host: candidates[0], state: null };
}

/**
 * Enforces conversation ↔ shop binding. If the conversation already has a
 * shopHost, the incoming request must match it or we throw.
 *
 * On first message (no shopHost yet), tags the conversation with the host.
 *
 * @param {string} conversationId
 * @param {string} shopHost
 * @throws {Error} if the conversation belongs to a different shop
 */
export async function enforceConversationShop(conversationId, shopHost) {
  if (!conversationId || !shopHost) return;

  const existing = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { shopHost: true },
  });

  if (!existing) {
    // Conversation will be created by saveMessage — we just pre-tag it.
    await prisma.conversation.upsert({
      where: { id: conversationId },
      create: { id: conversationId, shopHost },
      update: { shopHost },
    });
    return;
  }

  if (!existing.shopHost) {
    // Legacy conversation (pre-isolation) — tag it now.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { shopHost },
    });
    return;
  }

  if (existing.shopHost !== shopHost) {
    const err = new Error(
      `Conversation ${conversationId} belongs to shop ${existing.shopHost}, rejected request from ${shopHost}`
    );
    err.code = "SHOP_MISMATCH";
    throw err;
  }
}

export default { normalizeHost, resolveShopForRequest, enforceConversationShop };
