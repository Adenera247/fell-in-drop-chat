/**
 * Storefront Scraper
 *
 * Visits a Shopify storefront's public pages (discovered via sitemap.xml),
 * extracts clean text from each page, and returns a structured result that
 * can be merged into the knowledge base produced by the Admin GraphQL sync.
 *
 * This is the fallback for content the Admin API cannot see:
 *   - Theme sections with hard-coded info (shipping banners, warranty blocks)
 *   - App widgets rendered into the page (reviews, FAQ accordions)
 *   - Landing pages created by page-builder apps
 *   - Anything the merchant put in a custom theme section
 *
 * Pure HTTP + cheerio — no headless browser, no LLM, no external API.
 *
 * Public API:
 *   scrapeStorefront(baseUrl, options) → { pages: [{url, type, handle, title, content}] }
 *   mergeScrapedContent(knowledge, scraped, options) → mutates knowledge
 */
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; ClaudeChatBot/1.0; +https://srv1574024.hstgr.cloud)";

const CONTENT_SELECTORS = [
  "main",
  '[role="main"]',
  "#MainContent",
  "#main-content",
  ".main-content",
  ".product-single__description",
  ".product__description",
  ".rte",
];

const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "header",
  "footer",
  "nav",
  ".announcement-bar",
  ".site-header",
  ".site-footer",
  ".header",
  ".footer",
  ".main-menu",
  ".drawer",
  ".modal",
  ".popup",
  ".newsletter",
  ".cart-drawer",
  ".breadcrumb",
  "[aria-hidden='true']",
];

/**
 * Fetches a URL with timeout and user-agent.
 * Returns null on any error (404, timeout, network issue).
 */
async function fetchText(url, { timeoutMs = 10_000, userAgent = DEFAULT_USER_AGENT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "text/html,application/xml,text/xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses a sitemap XML string and returns an array of <loc> URLs.
 * Works for both sitemap index files (linking to child sitemaps) and
 * regular sitemaps (linking to actual pages).
 */
function parseSitemapLocs(xml) {
  if (!xml) return [];
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

/**
 * Discovers all public URLs on a storefront by walking the sitemap tree.
 * Returns a classified list: { products, pages, collections, other }.
 */
async function discoverUrls(baseUrl, { maxPages, timeoutMs }) {
  const sitemapRootUrl = new URL("/sitemap.xml", baseUrl).toString();
  const rootXml = await fetchText(sitemapRootUrl, { timeoutMs });
  if (!rootXml) return { products: [], pages: [], collections: [], other: [] };

  const rootLocs = parseSitemapLocs(rootXml);

  // Shopify sitemap.xml is usually an index pointing to child sitemaps.
  // Some tiny stores return a flat sitemap — handle both cases.
  const allUrls = new Set();

  const looksLikeChildSitemap = rootLocs.some((u) => u.includes("sitemap_") && u.endsWith(".xml"));

  if (looksLikeChildSitemap) {
    // Fetch every child sitemap in parallel (small number, usually <10)
    const childXmls = await Promise.all(
      rootLocs.map((u) => fetchText(u, { timeoutMs }))
    );
    for (const xml of childXmls) {
      for (const url of parseSitemapLocs(xml)) {
        allUrls.add(url);
      }
    }
  } else {
    for (const url of rootLocs) allUrls.add(url);
  }

  // Classify
  const classified = { products: [], pages: [], collections: [], other: [] };
  for (const url of allUrls) {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith("/products/")) classified.products.push(url);
      else if (path.startsWith("/pages/")) classified.pages.push(url);
      else if (path.startsWith("/collections/")) classified.collections.push(url);
      else if (path.startsWith("/policies/")) {
        // Policies are already covered by Admin API — skip entirely to save budget
      } else if (path.startsWith("/blogs/")) {
        // Blog posts can be huge and rarely contain SAV info — skip
      } else {
        classified.other.push(url);
      }
    } catch {
      // malformed URL, ignore
    }
  }

  // Prioritized cap: products first (most valuable for SAV), then pages, then collections
  const prioritized = [
    ...classified.products,
    ...classified.pages,
    ...classified.collections,
  ].slice(0, maxPages);

  // Re-classify the capped list so callers get consistent output
  const capped = { products: [], pages: [], collections: [], other: [] };
  for (const url of prioritized) {
    const path = new URL(url).pathname;
    if (path.startsWith("/products/")) capped.products.push(url);
    else if (path.startsWith("/pages/")) capped.pages.push(url);
    else if (path.startsWith("/collections/")) capped.collections.push(url);
  }
  return capped;
}

/**
 * Extracts clean text + title from an HTML string.
 */
function extractContent(html) {
  const $ = cheerio.load(html);

  // Strip noise
  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }

  // Find main content container using the first matching selector
  let $main = null;
  for (const sel of CONTENT_SELECTORS) {
    const found = $(sel).first();
    if (found.length > 0) {
      $main = found;
      break;
    }
  }
  if (!$main || $main.length === 0) {
    $main = $("body");
  }

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    null;

  // Extract and normalize text
  const rawText = $main.text() || "";
  const cleanText = rawText.replace(/\s+/g, " ").trim();

  return { title, content: cleanText };
}

/**
 * Parses a URL path into type + handle (e.g. /products/skin-aura → "products", "skin-aura").
 */
function parsePathMeta(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) return { type: parts[0], handle: parts[1] };
  } catch {
    // noop
  }
  return { type: "unknown", handle: null };
}

/**
 * Scrapes a single page and returns its extracted content (or null if failed).
 */
async function scrapePage(url, options) {
  const html = await fetchText(url, options);
  if (!html) return null;
  try {
    const { title, content } = extractContent(html);
    if (!content) return null;
    const { type, handle } = parsePathMeta(url);
    return { url, type, handle, title, content };
  } catch {
    return null;
  }
}

/**
 * Scrapes a Shopify storefront.
 *
 * @param {string} baseUrl - e.g. "https://zenovyra.com"
 * @param {Object} options
 * @param {number} [options.maxPages=300]
 * @param {number} [options.concurrency=5]
 * @param {number} [options.timeoutMs=10000]
 * @param {string} [options.userAgent]
 * @returns {Promise<{pages: Array}>}
 */
export async function scrapeStorefront(baseUrl, options = {}) {
  const {
    maxPages = 300,
    concurrency = 5,
    timeoutMs = 10_000,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  const urls = await discoverUrls(baseUrl, { maxPages, timeoutMs });
  const allUrls = [...urls.products, ...urls.pages, ...urls.collections];

  if (allUrls.length === 0) {
    return { pages: [] };
  }

  const limit = pLimit(concurrency);
  const fetchOpts = { timeoutMs, userAgent };

  const results = await Promise.all(
    allUrls.map((url) => limit(() => scrapePage(url, fetchOpts)))
  );

  const pages = results.filter(Boolean);
  return { pages };
}

/**
 * Merges scraped content into a knowledge base object produced by shop-sync.
 *
 * Attaches `scrapedContent` to each product that has a matching scraped
 * /products/:handle page. Non-product scraped pages are added to
 * `knowledge.scrapedPages[]`.
 *
 * Mutates `knowledge` in place.
 */
export function mergeScrapedContent(knowledge, scraped, options = {}) {
  if (!knowledge || !scraped?.pages?.length) return knowledge;

  const { maxCharsPerPage = 1500 } = options;
  const truncate = (s) => {
    if (!s) return "";
    return s.length > maxCharsPerPage ? s.slice(0, maxCharsPerPage) + "…" : s;
  };

  const productByHandle = new Map();
  if (Array.isArray(knowledge.products)) {
    for (const p of knowledge.products) {
      if (p.handle) productByHandle.set(p.handle, p);
    }
  }

  const scrapedPages = [];
  for (const page of scraped.pages) {
    if (page.type === "products" && page.handle) {
      const product = productByHandle.get(page.handle);
      if (product) {
        product.scrapedContent = truncate(page.content);
        continue;
      }
    }
    // Non-product scraped pages (pages, collections, orphan products)
    scrapedPages.push({
      url: page.url,
      title: page.title,
      content: truncate(page.content),
    });
  }

  knowledge.scrapedPages = scrapedPages;
  return knowledge;
}

export default { scrapeStorefront, mergeScrapedContent };
