/**
 * Claude Service
 * Manages interactions with the Claude API
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Renders a shop knowledge object (as produced by shop-sync.server.js) into
 * a compact, human-readable markdown block for injection into the system prompt.
 *
 * Returns two strings: boutiqueContext (shop + policies) and productsContext (catalog).
 */
function renderShopKnowledge(knowledge) {
  if (!knowledge) {
    return {
      boutiqueContext:
        "(Catalogue en cours de synchronisation — utilise search_shop_catalog pour toute question produit)",
      productsContext:
        "(Catalogue en cours de synchronisation — utilise search_shop_catalog pour toute question produit)",
    };
  }

  const shop = knowledge.shop || {};
  const policies = knowledge.policies || {};
  const pages = knowledge.pages || [];
  const collections = knowledge.collections || [];
  const scrapedPages = knowledge.scrapedPages || [];
  const products = knowledge.products || [];

  // --- Boutique context ---
  const boutiqueLines = [];
  boutiqueLines.push(`## Infos boutique`);
  if (shop.name) boutiqueLines.push(`- **Nom** : ${shop.name}`);
  if (shop.url) boutiqueLines.push(`- **URL** : ${shop.url}`);
  if (shop.currency) boutiqueLines.push(`- **Devise** : ${shop.currency}`);
  if (shop.country || shop.city)
    boutiqueLines.push(`- **Localisation** : ${[shop.city, shop.country].filter(Boolean).join(", ")}`);
  if (shop.timezone) boutiqueLines.push(`- **Fuseau** : ${shop.timezone}`);
  if (Array.isArray(shop.shipsToCountries) && shop.shipsToCountries.length) {
    const sample = shop.shipsToCountries.slice(0, 20).join(", ");
    boutiqueLines.push(
      `- **Livre vers** : ${sample}${shop.shipsToCountries.length > 20 ? ` (+${shop.shipsToCountries.length - 20} autres)` : ""}`
    );
  }

  if (policies.shipping || policies.refund || policies.privacy || policies.terms) {
    boutiqueLines.push("");
    boutiqueLines.push(`## Politiques de la boutique`);
    if (policies.shipping)
      boutiqueLines.push(`### Livraison\n${policies.shipping}`);
    if (policies.refund)
      boutiqueLines.push(`### Retours / Remboursement\n${policies.refund}`);
    if (policies.privacy)
      boutiqueLines.push(`### Confidentialité\n${policies.privacy}`);
    if (policies.terms)
      boutiqueLines.push(`### CGU\n${policies.terms}`);
  }

  if (collections.length) {
    boutiqueLines.push("");
    boutiqueLines.push(`## Collections / Catégories`);
    for (const c of collections) {
      const meta = c.productCount != null ? ` (${c.productCount} produits)` : "";
      boutiqueLines.push(`- **${c.title}**${meta}`);
      if (c.description) boutiqueLines.push(`  ${c.description}`);
    }
  }

  if (pages.length) {
    boutiqueLines.push("");
    boutiqueLines.push(`## Pages de la boutique`);
    for (const p of pages) {
      boutiqueLines.push(`### ${p.title}`);
      if (p.body) boutiqueLines.push(p.body);
    }
  }

  if (scrapedPages.length) {
    boutiqueLines.push("");
    boutiqueLines.push(`## Pages publiques supplémentaires (capturées depuis la boutique)`);
    for (const sp of scrapedPages) {
      boutiqueLines.push(`### ${sp.title || sp.url}`);
      if (sp.content) boutiqueLines.push(sp.content);
    }
  }

  // --- Products context ---
  const productLines = [];
  productLines.push(`## Catalogue (${products.length} produits)`);
  if (products.length === 0) {
    productLines.push("(Aucun produit dans le catalogue pour le moment)");
  } else {
    for (const p of products) {
      const price =
        p.priceMin && p.priceMax && p.priceMin !== p.priceMax
          ? `${p.priceMin}–${p.priceMax} ${p.currency || ""}`.trim()
          : p.priceMin
          ? `${p.priceMin} ${p.currency || ""}`.trim()
          : "prix indisponible";
      const parts = [`**${p.title}** — ${price}`];
      if (p.productType) parts.push(`_${p.productType}_`);
      if (p.url) parts.push(`[lien](${p.url})`);
      productLines.push(`- ${parts.join(" · ")}`);
      if (p.description) productLines.push(`  ${p.description}`);

      // Metafields — where merchants typically stash warranty, delivery delays, etc.
      if (Array.isArray(p.metafields) && p.metafields.length) {
        productLines.push(`  Infos additionnelles :`);
        for (const mf of p.metafields) {
          productLines.push(`  - ${mf.key}: ${mf.value}`);
        }
      }

      // Scraped page content — fallback capture from the public product page
      if (p.scrapedContent) {
        productLines.push(`  Contenu de la page produit publique :`);
        productLines.push(`  ${p.scrapedContent}`);
      }

      // Collections membership — helps for "do you have any X category?"
      if (Array.isArray(p.collections) && p.collections.length) {
        const colList = p.collections.map((c) => c.title).join(", ");
        productLines.push(`  Catégories : ${colList}`);
      }
    }
  }

  return {
    boutiqueContext: boutiqueLines.join("\n"),
    productsContext: productLines.join("\n"),
  };
}

/**
 * Creates a Claude service instance
 * @param {string} apiKey - Claude API key
 * @returns {Object} Claude service with methods for interacting with Claude API
 */
export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  // Initialize Claude client
  const anthropic = new Anthropic({ apiKey });

  /**
   * Streams a conversation with Claude
   * @param {Object} params - Stream parameters
   * @param {Array} params.messages - Conversation history
   * @param {string} params.promptType - The type of system prompt to use
   * @param {Array} params.tools - Available tools for Claude
   * @param {Object} params.shopKnowledge - Optional shop knowledge base to inject
   * @param {Object} streamHandlers - Stream event handlers
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools,
    shopKnowledge = null,
  }, streamHandlers) => {
    // Get system prompt from configuration or use default
    const systemInstruction = getSystemPrompt(promptType, shopKnowledge);

    // Create stream
    const stream = await anthropic.messages.stream({
      model: AppConfig.api.defaultModel,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined
    });

    // Set up event handlers
    if (streamHandlers.onText) {
      stream.on('text', streamHandlers.onText);
    }

    if (streamHandlers.onMessage) {
      stream.on('message', streamHandlers.onMessage);
    }

    if (streamHandlers.onContentBlock) {
      stream.on('contentBlock', streamHandlers.onContentBlock);
    }

    // Wait for final message
    const finalMessage = await stream.finalMessage();

    // Process tool use requests
    if (streamHandlers.onToolUse && finalMessage.content) {
      for (const content of finalMessage.content) {
        if (content.type === "tool_use") {
          await streamHandlers.onToolUse(content);
        }
      }
    }

    return finalMessage;
  };

  /**
   * Gets the system prompt content for a given prompt type.
   * Injects the shop knowledge base into {{BOUTIQUE_CONTEXT}} / {{PRODUCTS_CONTEXT}}
   * placeholders if present in the prompt template.
   * @param {string} promptType - The prompt type to retrieve
   * @param {Object} shopKnowledge - Optional knowledge base object
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType, shopKnowledge = null) => {
    let prompt = systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;

    if (prompt.includes("{{BOUTIQUE_CONTEXT}}") || prompt.includes("{{PRODUCTS_CONTEXT}}")) {
      const { boutiqueContext, productsContext } = renderShopKnowledge(shopKnowledge);
      prompt = prompt.replace("{{BOUTIQUE_CONTEXT}}", boutiqueContext);
      prompt = prompt.replace("{{PRODUCTS_CONTEXT}}", productsContext);
    }

    return prompt;
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
