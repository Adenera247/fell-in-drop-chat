/**
 * Claude Service
 * Manages interactions with the Claude API
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";
import fs from "fs";
import path from "path";

/**
 * Loads all context files from context/ directory
 * Returns an object with boutiqueContext and productsContext strings
 */
function loadContextFiles() {
  // Resolve context/ relative to project root (3 levels up from services/)
  const projectRoot = path.resolve(process.cwd(), "..");
  const contextDir = path.join(projectRoot, "context");

  let boutiqueContext = "";
  let productsContext = "";

  // Load boutique.md
  const boutiquePath = path.join(contextDir, "boutique.md");
  if (fs.existsSync(boutiquePath)) {
    boutiqueContext = fs.readFileSync(boutiquePath, "utf-8").trim();
  }
  if (!boutiqueContext) {
    boutiqueContext = "(Aucune info boutique configuree)";
  }

  // Load faq-auto.md and append to boutique context
  const faqAutoPath = path.join(contextDir, "faq-auto.md");
  if (fs.existsSync(faqAutoPath)) {
    const faqContent = fs.readFileSync(faqAutoPath, "utf-8").trim();
    if (faqContent) {
      boutiqueContext += "\n\n---\n## FAQ AUTO-GENEREE (questions recurrentes detectees)\n" + faqContent;
    }
  }

  // Load all product files from context/produits/
  const produitsDir = path.join(contextDir, "produits");
  if (fs.existsSync(produitsDir)) {
    const files = fs.readdirSync(produitsDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(produitsDir, file), "utf-8").trim();
      if (content) {
        productsContext += `\n\n---\n### ${file.replace(".md", "").replace(/-/g, " ").toUpperCase()}\n${content}`;
      }
    }
  }
  if (!productsContext) {
    productsContext = "(Aucune fiche produit configuree)";
  }

  return { boutiqueContext, productsContext };
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
   * @param {Object} streamHandlers - Stream event handlers
   * @param {Function} streamHandlers.onText - Handles text chunks
   * @param {Function} streamHandlers.onMessage - Handles complete messages
   * @param {Function} streamHandlers.onToolUse - Handles tool use requests
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    // Get system prompt from configuration or use default
    const systemInstruction = getSystemPrompt(promptType);

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
   * Gets the system prompt content for a given prompt type
   * Injects dynamic context from context/ files for savAgent prompt
   * @param {string} promptType - The prompt type to retrieve
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType) => {
    let prompt = systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;

    // Inject dynamic context if prompt contains placeholders
    if (prompt.includes("{{BOUTIQUE_CONTEXT}}") || prompt.includes("{{PRODUCTS_CONTEXT}}")) {
      const { boutiqueContext, productsContext } = loadContextFiles();
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
