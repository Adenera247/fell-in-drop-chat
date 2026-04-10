/**
 * Local tools
 *
 * Tools implemented in this app's own code, called by Claude alongside the
 * Shopify MCP tools. Each local tool has the same schema shape Anthropic
 * expects (name, description, input_schema) so Claude can't distinguish
 * them from MCP tools.
 *
 * Why "local"?
 *   - They run as plain JS on this VPS (not on a Shopify MCP server)
 *   - They use the merchant's own Admin API token stored in the Session table
 *   - They return strictly whitelisted fields — Claude never sees raw API
 *     responses, so sensitive data cannot leak through the tool output
 *
 * Public API:
 *   getLocalTools()              → array of tool definitions for Claude
 *   isLocalTool(name)            → predicate, used by chat.jsx to dispatch
 *   callLocalTool(name, args, ctx) → invokes the handler, returns MCP-shape response
 */
import { unauthenticated } from "../shopify.server";

// ---------- Tool: lookup_order_status ----------

const LOOKUP_ORDER_STATUS = {
  name: "lookup_order_status",
  description:
    "Look up the status of a customer order using the order number and the customer's email. " +
    "Use this when the customer is NOT logged in (the MCP tools get_most_recent_order_status / " +
    "get_order_status failed with auth_required). Always ask for BOTH the order number (e.g. #ZA1022PL) " +
    "AND the email address used at checkout before calling this tool. " +
    "If the tool returns { found: false }, politely ask the customer to double-check both pieces of info.",
  input_schema: {
    type: "object",
    properties: {
      order_name: {
        type: "string",
        description:
          "The order number, with or without a leading #. Strict match otherwise (case-sensitive, no extra spaces). Example: 'ZA1022PL' or '#ZA1022PL'.",
      },
      email: {
        type: "string",
        description: "The email address the customer used when placing the order.",
      },
    },
    required: ["order_name", "email"],
  },
};

const ORDER_LOOKUP_QUERY = `#graphql
  query OrderLookup($query: String!) {
    orders(first: 2, query: $query) {
      edges {
        node {
          id
          name
          createdAt
          displayFulfillmentStatus
          displayFinancialStatus
          customer { email }
          shippingAddress {
            city
            country
            province
          }
          fulfillments(first: 5) {
            status
            createdAt
            trackingInfo {
              number
              url
              company
            }
            estimatedDeliveryAt
          }
        }
      }
    }
  }
`;

/**
 * Normalizes the order_name input:
 *  - Trims whitespace
 *  - Strips a single leading '#' if present (Shopify stores and queries with '#')
 *  - Rejects anything that still contains whitespace or is empty
 *
 * Returns the raw number (no #) for use in GraphQL search query.
 * Returns null if the input is unusable.
 */
function normalizeOrderName(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  if (s.startsWith("#")) s = s.slice(1);
  // Strict: no internal whitespace allowed
  if (/\s/.test(s)) return null;
  // Strict: must have at least one character and no more than 32
  if (s.length < 1 || s.length > 32) return null;
  return s;
}

/**
 * Basic email shape check. We don't validate the deliverability — we just
 * want to avoid passing obvious garbage to Shopify's search, and avoid
 * Shopify search query injection.
 */
function normalizeEmail(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.length > 254) return null;
  // Very permissive: must contain one '@' with characters on both sides
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/**
 * Builds the Shopify search query string.
 * We use BOTH name and email as filters — the customer must know both to
 * successfully look up an order. This is the same protection level as a
 * standard "track my order" public page.
 */
function buildSearchQuery(orderName, email) {
  // Escape double quotes in case someone tries something funny
  const safeName = orderName.replace(/"/g, "");
  const safeEmail = email.replace(/"/g, "");
  return `name:"#${safeName}" email:"${safeEmail}"`;
}

/**
 * Whitelisted projection of a Shopify order node into what Claude is
 * allowed to see. Anything not listed here is dropped — this is the
 * second layer of defense (the first being the GraphQL query itself
 * only requesting safe fields).
 */
function projectOrder(node) {
  const latestFulfillment = (node.fulfillments || [])[0] || null;
  const tracking = latestFulfillment?.trackingInfo?.[0] || null;
  const shipping = node.shippingAddress || {};
  return {
    order_name: node.name, // e.g. "#ZA1022PL"
    created_at: node.createdAt,
    fulfillment_status: node.displayFulfillmentStatus || "UNFULFILLED", // FULFILLED, IN_PROGRESS, etc.
    financial_status: node.displayFinancialStatus || null, // PAID, REFUNDED, etc.
    tracking_number: tracking?.number || null,
    tracking_url: tracking?.url || null,
    tracking_company: tracking?.company || null,
    estimated_delivery: latestFulfillment?.estimatedDeliveryAt || null,
    last_fulfillment_update: latestFulfillment?.createdAt || null,
    shipping_city: shipping.city || null,
    shipping_province: shipping.province || null,
    shipping_country: shipping.country || null,
  };
}

/**
 * Handler for lookup_order_status. Receives the normalized shop context
 * from chat.jsx and the raw args from Claude.
 *
 * Returns an MCP-shape content array so the caller can pass it directly
 * to tool.server.js as if it came from a real MCP tool.
 */
async function handleLookupOrderStatus(args, { shop }) {
  const orderNameRaw = args?.order_name;
  const emailRaw = args?.email;

  const orderName = normalizeOrderName(orderNameRaw);
  const email = normalizeEmail(emailRaw);

  if (!orderName || !email) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: false,
            error: "invalid_input",
            message:
              "Le numéro de commande ou l'email est invalide. Demande au client de les revérifier.",
          }),
        },
      ],
    };
  }

  if (!shop) {
    // Should never happen — chat.jsx always resolves a shop — but be defensive.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: false,
            error: "no_shop_context",
            message: "Impossible de déterminer la boutique pour cette recherche.",
          }),
        },
      ],
    };
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const query = buildSearchQuery(orderName, email);
    const response = await admin.graphql(ORDER_LOOKUP_QUERY, {
      variables: { query },
    });
    const json = await response.json();

    if (json.errors) {
      console.warn(
        `[local-tools] lookup_order_status GraphQL error for ${shop}:`,
        JSON.stringify(json.errors).slice(0, 300)
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              found: false,
              error: "api_error",
              message:
                "La recherche n'a pas pu aboutir pour une raison technique. Essaie de reformuler ou transfère à l'équipe.",
            }),
          },
        ],
      };
    }

    const edges = json?.data?.orders?.edges || [];
    if (edges.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              found: false,
              message:
                "Aucune commande trouvée avec ce numéro et cet email. Demande au client de vérifier les deux informations.",
            }),
          },
        ],
      };
    }

    if (edges.length > 1) {
      // Extremely unlikely given we filter by both name + email, but worth
      // logging as a safety net.
      console.warn(
        `[local-tools] lookup_order_status: multiple matches for ${shop} — returning first only`
      );
    }

    const order = projectOrder(edges[0].node);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ found: true, order }),
        },
      ],
    };
  } catch (err) {
    console.error(`[local-tools] lookup_order_status failed for ${shop}:`, err.message);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: false,
            error: "exception",
            message:
              "La recherche a échoué. Tu peux transférer la demande à l'équipe.",
          }),
        },
      ],
    };
  }
}

// ---------- Registry ----------

const LOCAL_TOOLS = [
  {
    definition: LOOKUP_ORDER_STATUS,
    handler: handleLookupOrderStatus,
  },
];

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.definition.name));

/**
 * Returns the list of tool definitions to pass to Claude, in the same
 * shape as MCP tools ({ name, description, input_schema }).
 */
export function getLocalTools() {
  return LOCAL_TOOLS.map((t) => t.definition);
}

/**
 * Returns true if this tool name corresponds to a local handler.
 */
export function isLocalTool(name) {
  return LOCAL_TOOL_NAMES.has(name);
}

/**
 * Invokes the local handler for a given tool name. Returns an MCP-shape
 * response so chat.jsx can treat it identically to an MCP tool result.
 *
 * @param {string} name - Tool name
 * @param {Object} args - Tool input arguments
 * @param {Object} context - { shop: string } — the authenticated shop domain
 */
export async function callLocalTool(name, args, context) {
  const entry = LOCAL_TOOLS.find((t) => t.definition.name === name);
  if (!entry) {
    return {
      error: {
        type: "unknown_tool",
        data: `Local tool ${name} does not exist`,
      },
    };
  }
  return entry.handler(args, context);
}

export default { getLocalTools, isLocalTool, callLocalTool };
