/**
 * Chat API Route
 * Handles chat interactions with Claude API and tools
 */
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createClaudeService } from "../services/claude.server";
import { createToolService } from "../services/tool.server";
import { getShopKnowledge } from "../services/shop-knowledge.server";
import { resolveShopForRequest, enforceConversationShop } from "../services/shop-identity.server";
import { getLocalTools, isLocalTool, callLocalTool } from "../services/local-tools.server";

// Regex matching phrases where the bot admits it can't help and defers to
// the human team — used to flag the message as "fallback" for analytics.
const FALLBACK_TEXT_RE =
  /je (la |le )?transmets|l['’][ée]quipe (te |vous )?(revient|recontacte|repond)|on (te |vous )?recontacte|je ne (sais|peux) pas (t['’]aider|vous aider|repondre)|on (va |te |vous )?(revenir|transmettre) (vers|à|a) (toi|vous|l['’][ée]quipe)|contacte(r)? l['’][ée]quipe|hors de mes competences|hors de ma competence/i;

function extractAssistantText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

function detectFallback(message) {
  if (!message?.content) return false;
  // Signal A: Claude invoked a tool named escalate_* (will be defined in Phase 2)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        if (block.name.startsWith("escalate")) return true;
      }
    }
  }
  // Signal B: text pattern indicating the bot is punting to humans
  const text = extractAssistantText(message.content);
  return FALLBACK_TEXT_RE.test(text);
}

/**
 * Repairs a conversation history loaded from the DB so it is valid for
 * Claude's Messages API. Two known problems this fixes:
 *
 *   1. Pre-existing code saved each tool_result in its OWN user message
 *      (addToolResultToHistory was called once per tool_use block). Claude
 *      requires ALL tool_result blocks for a given assistant tool_use batch
 *      to appear in a SINGLE user message directly after the assistant.
 *      This function consumes consecutive pure tool_result user messages
 *      and merges them into one.
 *
 *   2. If a tool dispatch crashed mid-flow, the DB may have an assistant
 *      message with tool_use blocks but no tool_result messages at all.
 *      Synthetic tool_result blocks are generated for any missing ids so
 *      Claude accepts the conversation.
 *
 * Behaviour-wise, the sanitizer is a pure function: it never mutates the
 * input, and it emits exactly one user message with all tool_result blocks
 * (plus any trailing user text merged in if needed) after every assistant
 * message that contains tool_use blocks.
 */
function sanitizeConversationHistory(messages) {
  const out = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // Pass-through for any message that isn't an assistant with tool_use
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      i += 1;
      continue;
    }

    const toolUseIds = msg.content
      .filter((c) => c?.type === "tool_use")
      .map((c) => c.id);

    if (toolUseIds.length === 0) {
      out.push(msg);
      i += 1;
      continue;
    }

    // Assistant with tool_use: emit it, then process the following messages.
    out.push(msg);
    i += 1;

    // Step 1 — consume consecutive PURE tool_result user messages and
    // collect all their blocks.
    const collectedResults = [];
    const seenIds = new Set();

    while (i < messages.length) {
      const next = messages[i];
      if (next.role !== "user") break;
      if (!Array.isArray(next.content)) break;
      const isPureToolResults =
        next.content.length > 0 &&
        next.content.every((c) => c?.type === "tool_result");
      if (!isPureToolResults) break;

      for (const block of next.content) {
        if (!seenIds.has(block.tool_use_id)) {
          collectedResults.push(block);
          seenIds.add(block.tool_use_id);
        }
      }
      i += 1;
    }

    // Step 2 — synthesize tool_result blocks for any tool_use ids that
    // were never paired (catastrophic failure during prior turn).
    for (const expectedId of toolUseIds) {
      if (!seenIds.has(expectedId)) {
        collectedResults.push({
          type: "tool_result",
          tool_use_id: expectedId,
          content:
            "Tool result missing — synthesized for conversation continuity.",
          is_error: true,
        });
      }
    }

    // Step 3 — if the NEXT (still unconsumed) message is a user text
    // message, merge the tool_result blocks with its content so we don't
    // end up with two consecutive user messages.
    let trailingUserBlocks = [];
    if (i < messages.length && messages[i].role === "user") {
      const next = messages[i];
      if (Array.isArray(next.content)) {
        trailingUserBlocks = next.content;
      } else {
        trailingUserBlocks = [{ type: "text", text: String(next.content) }];
      }
      i += 1;
    }

    out.push({
      role: "user",
      content: [...collectedResults, ...trailingUserBlocks],
    });
  }

  return out;
}


/**
 * Rract Router loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // Handle SSE requests
  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

/**
 * React Router action function for handling POST requests
 */
export async function action({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 * @param {Request} request - The request object
 * @param {string} conversationId - The conversation ID
 * @returns {Response} JSON response with chat history
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);

  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 * @param {Request} request - The request object
 * @returns {Response} Server-sent events stream
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;

    // Validate required message
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Validate message length (prevent abuse)
    if (typeof userMessage !== 'string' || userMessage.length > 2000) {
      return new Response(
        JSON.stringify({ error: "Message too long. Maximum 2000 characters." }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Generate or use existing conversation ID
    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;
    const clientApiKey = body.api_key || '';
    const storeDomain = body.store_domain || '';

    // Validate API key
    if (!clientApiKey && !process.env.CLAUDE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "No API key configured. Please add your Claude API key in the theme editor." }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream,
        apiKey: clientApiKey || process.env.CLAUDE_API_KEY,
        storeDomain
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session
 * @param {Object} params - Session parameters
 * @param {Request} params.request - The request object
 * @param {string} params.userMessage - The user's message
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.promptType - The prompt type
 * @param {Object} params.stream - Stream manager for sending responses
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream,
  apiKey,
  storeDomain
}) {
  // Initialize services - use merchant's API key
  const claudeService = createClaudeService(apiKey);
  const toolService = createToolService();

  // Resolve the authoritative shop for this request — single source of
  // truth for isolation. See services/shop-identity.server.js.
  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const origin = request.headers.get("Origin");
  const resolved = await resolveShopForRequest({ origin, storeDomain });

  if (!resolved) {
    stream.sendMessage({
      type: "error",
      error: "Unable to identify the shop for this request.",
    });
    return;
  }

  // shopDomain is ALWAYS the myshopify.com domain when the shop is known in
  // our DB. If the shop has never been synced yet, it falls back to whatever
  // hostname was resolved (storeDomain or Origin) so the conversation can
  // still be tagged consistently.
  const shopDomain = resolved.shopDomain;
  // myshopifyDomain is the authoritative myshopify identifier used by
  // unauthenticated.admin() to fetch the stored offline token. Only
  // available if the merchant is installed (ShopSyncState row exists).
  const myshopifyDomain = resolved.state?.shop || null;
  // The public host of the storefront (custom domain if set, else
  // myshopify). Used for the MCP storefront URL because Shopify's MCP
  // server wants to be hit at the public-facing domain.
  const storefrontHost =
    resolved.state?.primaryHost || resolved.state?.shop || shopDomain;

  // Enforce conversation ↔ shopDomain binding. If an existing conversation
  // is reused from a different shop, reject the request.
  try {
    await enforceConversationShop(conversationId, shopDomain);
  } catch (err) {
    if (err.code === "SHOP_MISMATCH") {
      console.warn(`[chat] rejecting ${conversationId}: ${err.message}`);
      stream.sendMessage({
        type: "error",
        error: "This conversation belongs to a different shop.",
      });
      return;
    }
    throw err;
  }

  // Build the storefront URL from the resolved host (myshopify or custom
  // domain) — never trust body-only values.
  const storefrontUrl = `https://${storefrontHost}`;
  const { mcpApiUrl } = await getCustomerAccountUrls(storefrontUrl, conversationId);

  console.log(`MCP connecting to store: ${storefrontUrl} (shopId: ${shopId}, shopDomain: ${shopDomain})`);

  const mcpClient = new MCPClient(
    storefrontUrl,
    conversationId,
    shopId,
    mcpApiUrl,
  );

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    // Connect to MCP servers and get available tools
    let storefrontMcpTools = [], customerMcpTools = [];

    try {
      storefrontMcpTools = await mcpClient.connectToStorefrontServer();
      customerMcpTools = await mcpClient.connectToCustomerServer();

      console.log(`Connected to MCP with ${storefrontMcpTools.length} tools`);
      console.log(`Connected to customer MCP with ${customerMcpTools.length} tools`);
    } catch (error) {
      console.warn('Failed to connect to MCP servers, continuing without tools:', error.message);
    }

    // Prepare conversation state
    let conversationHistory = [];
    let productsToDisplay = [];

    // Save user message to the database
    await saveMessage(conversationId, 'user', userMessage);

    // Fetch conversation history and shop knowledge in parallel.
    // getShopKnowledge accepts either the myshopify domain or the public
    // host — we pass shopDomain (myshopify) because it's the stable key.
    const [dbMessages, shopKnowledge] = await Promise.all([
      getConversationHistory(conversationId),
      shopDomain ? getShopKnowledge(shopDomain) : Promise.resolve(null),
    ]);

    if (shopKnowledge) {
      console.log(`[chat] loaded shop knowledge for ${shopDomain} (${shopKnowledge.productCount ?? 0} products)`);
    } else if (shopDomain) {
      console.log(`[chat] no shop knowledge yet for ${shopDomain} — fallback to MCP tools only`);
    }

    // Format messages for Claude API, then sanitize to repair any pre-existing
    // tool_use/tool_result mismatch in the DB (legacy conversations saved
    // before the batching fix, or conversations where a tool dispatch crashed).
    const rawHistory = dbMessages.map((dbMessage) => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
      }
      return { role: dbMessage.role, content };
    });
    conversationHistory = sanitizeConversationHistory(rawHistory);
    if (conversationHistory.length !== rawHistory.length) {
      console.log(
        `[chat] sanitized conversation ${conversationId}: ${rawHistory.length} → ${conversationHistory.length} messages`
      );
    }

    // Merge MCP tools with local tools. Local tools only become available
    // if we have a myshopify domain (i.e. the merchant installed the app),
    // because they rely on the stored offline admin token.
    const localTools = myshopifyDomain ? getLocalTools() : [];
    const allTools = [...(mcpClient.tools || []), ...localTools];

    // Execute the conversation stream.
    //
    // Tool results are BATCHED: every tool_use block Claude emits in a
    // single response must be paired with a tool_result block in the very
    // next user message — and Claude's API rejects tool_result blocks
    // scattered across multiple user messages. We accumulate all results
    // in pendingToolResults during the onToolUse callbacks, then flush
    // them as ONE user message at the top of the next loop iteration
    // (before the next streamConversation call).
    let finalMessage = { role: "user", content: userMessage };
    let pendingToolResults = [];

    while (finalMessage.stop_reason !== "end_turn") {
      // Flush batched tool_result blocks from the previous iteration as
      // one consolidated user message.
      if (pendingToolResults.length > 0) {
        const batchMessage = {
          role: "user",
          content: pendingToolResults,
        };
        conversationHistory.push(batchMessage);
        try {
          await saveMessage(
            conversationId,
            "user",
            JSON.stringify(pendingToolResults)
          );
        } catch (err) {
          console.error("Error saving batched tool_result message:", err);
        }
        pendingToolResults = [];
      }

      finalMessage = await claudeService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: allTools,
          shopKnowledge,
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: 'chunk',
              chunk: textDelta
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            conversationHistory.push({
              role: message.role,
              content: message.content
            });

            // Capture metrics for assistant messages: token usage + fallback detection.
            // Only assistant turns have usage data from Claude; user/tool_result
            // messages saved here come through other paths.
            const meta = {};
            if (message.role === "assistant") {
              const usage = message.usage;
              if (usage) {
                meta.tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
              }
              meta.fallbackUsed = detectFallback(message);
            }

            saveMessage(conversationId, message.role, JSON.stringify(message.content), meta)
              .catch((error) => {
                console.error("Error saving message to database:", error);
              });

            // Send a completion message
            stream.sendMessage({ type: 'message_complete' });
          },

          // Handle tool use requests.
          //
          // IMPORTANT: we do NOT push to conversationHistory or call
          // saveMessage here. Instead we accumulate tool_result blocks in
          // pendingToolResults so they can be flushed as ONE user message
          // at the top of the next while loop iteration. This is required
          // by Claude's API when multiple tools are used in a single turn.
          onToolUse: async (content) => {
            const toolName = content.name;
            const toolArgs = content.input;
            const toolUseId = content.id;

            stream.sendMessage({
              type: "tool_use",
              tool_use_message: `Calling tool: ${toolName} with arguments: ${JSON.stringify(toolArgs)}`,
            });

            // Dispatch with a safety net: any thrown exception becomes a
            // synthetic error response so we ALWAYS produce a tool_result
            // block for every tool_use id Claude sent.
            let toolUseResponse;
            try {
              if (isLocalTool(toolName)) {
                toolUseResponse = await callLocalTool(toolName, toolArgs, {
                  shop: myshopifyDomain,
                });
              } else {
                toolUseResponse = await mcpClient.callTool(toolName, toolArgs);
              }
            } catch (err) {
              console.error(
                `[chat] tool ${toolName} dispatch threw:`,
                err.message
              );
              toolUseResponse = {
                error: {
                  type: "dispatch_error",
                  data: `Tool ${toolName} crashed: ${err.message}`,
                },
              };
            }

            // Build the tool_result block content + handle side effects.
            let resultContent;
            let isError = false;
            if (toolUseResponse.error) {
              resultContent = toolUseResponse.error.data;
              isError = true;

              // Preserve the original auth_required client signal
              if (toolUseResponse.error.type === "auth_required") {
                stream.sendMessage({ type: "auth_required" });
              }
            } else {
              resultContent = toolUseResponse.content;

              // Product display side-effect (from the original handleToolSuccess)
              if (toolName === AppConfig.tools.productSearchName) {
                try {
                  productsToDisplay.push(
                    ...toolService.processProductSearchResult(toolUseResponse)
                  );
                } catch (e) {
                  console.warn(
                    "[chat] processProductSearchResult failed:",
                    e.message
                  );
                }
              }
            }

            pendingToolResults.push({
              type: "tool_result",
              tool_use_id: toolUseId,
              content: resultContent,
              ...(isError ? { is_error: true } : {}),
            });

            // Signal new message to client
            stream.sendMessage({ type: "new_message" });
          },

          // Handle content block completion
          onContentBlock: (contentBlock) => {
            if (contentBlock.type === 'text') {
              stream.sendMessage({
                type: 'content_block_complete',
                content_block: contentBlock
              });
            }
          }
        }
      );
    }

    // Safety net: if the loop exited with pending tool_results (shouldn't
    // normally happen because end_turn means Claude emitted no tool_use),
    // persist them so the conversation isn't left in a broken state.
    if (pendingToolResults.length > 0) {
      console.warn(
        `[chat] ${pendingToolResults.length} pending tool_result(s) at end of conversation — flushing`
      );
      const batchMessage = { role: "user", content: pendingToolResults };
      conversationHistory.push(batchMessage);
      await saveMessage(
        conversationId,
        "user",
        JSON.stringify(pendingToolResults)
      ).catch((err) =>
        console.error("Final tool_result flush failed:", err)
      );
      pendingToolResults = [];
    }

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

    // Send product results if available
    if (productsToDisplay.length > 0) {
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });
    }
  } catch (error) {
    // The streaming handler takes care of error handling
    throw error;
  }
}

/**
 * Get the customer MCP API URL for a shop
 * @param {string} shopDomain - The shop domain
 * @param {string} conversationId - The conversation ID
 * @returns {string} The customer MCP API URL
 */
async function getCustomerAccountUrls(shopDomain, conversationId) {
  try {
    // Check if the customer account URL exists in the DB
    const existingUrls = await getCustomerAccountUrlsFromDb(conversationId);

    // If URL exists, return early with the MCP API URL
    if (existingUrls) return existingUrls;

    // If not, query for it from the Shopify API
    const { hostname } = new URL(shopDomain);

    const urls = await Promise.all([
      fetch(`https://${hostname}/.well-known/customer-account-api`).then(res => res.json()),
      fetch(`https://${hostname}/.well-known/openid-configuration`).then(res => res.json()),
    ]).then(async ([mcpResponse, openidResponse]) => {
      const response = {
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      };

      await storeCustomerAccountUrls({
        conversationId,
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      });

      return response;
    });

    return urls;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return null;
  }
}

/**
 * Gets CORS headers for the response
 * @param {Request} request - The request object
 * @returns {Object} CORS headers object
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400" // 24 hours
  };
}

/**
 * Get SSE headers for the response
 * @param {Request} request - The request object
 * @returns {Object} SSE headers object
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}
