// @facet-llc/adapter — cross-merchant MCP tool definitions.
//
// The canonical, single-source tool schemas for Facet's network-level MCP
// surface: the four tools an AI agent uses to discover businesses in the
// Universal Business Index, enter a merchant, browse its catalog, and price a
// cart. Both consumers import these verbatim so the local package
// (@facet-llc/mcp, stdio) and the hosted Facet Terminal endpoint (streamable
// HTTP) advertise identical tool contracts:
//
//   - facet_discover        → POST /v1/discover  (UBI directory search)
//   - facet_get_merchant    → agents.txt + /v1/capabilities + /v1/terms
//   - facet_search_products → POST /v1/search    (per-merchant catalog)
//   - facet_quote           → POST /v1/quote     (landed total + quote_token)
//
// Distinct from packages/ucp CATALOG_MCP_TOOLS, which are the per-merchant UCP
// catalog bindings served at /ucp/mcp. These are the merchant-agnostic tools
// keyed off the directory, so a merchant argument selects the target Terminal.

/** An MCP tool definition (name + description + JSON Schema input), plus the
 *  Facet-specific metadata both MCP hosts need to register and gate the tool. */
export interface FacetMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** MCP tool annotations (client/UX hints). Every Facet v1 tool is read-only
   *  and operates against the open web of merchants, so all carry
   *  `{ readOnlyHint: true, openWorldHint: true }`. */
  readonly annotations: Readonly<Record<string, unknown>>;
  /** Whether the tool hits a KYA-gated Terminal route (search, quote) and so
   *  needs the caller's identity, versus a public directory read (discover,
   *  get_merchant). The hosted MCP uses this to serve discover/get_merchant to
   *  anonymous callers in-process while gating search/quote behind a bearer; the
   *  local package uses it to know an enrolled identity must exist before
   *  dispatch. Note: the Cloudflare edge WAF gates ALL /v1/* regardless, so the
   *  local package (which crosses the edge) always carries a token — this flag
   *  drives the hosted anonymous tier, which dispatches in-process past the WAF. */
  readonly requiresIdentity: boolean;
}

const READ_ONLY_OPEN_WORLD = { readOnlyHint: true, openWorldHint: true } as const;

// Shared ship-to address schema, reused by facet_quote. Kept minimal and
// agent-friendly: the fields a Terminal needs to compute a landed quote.
const SHIP_TO_SCHEMA = {
  type: "object",
  description: "Destination address used to compute shipping and tax for the landed quote.",
  required: ["line1", "city", "region", "postal_code", "country"],
  properties: {
    recipient: { type: "string", description: "Recipient name." },
    line1: { type: "string", description: "Street address line 1." },
    line2: { type: "string", description: "Street address line 2 (optional)." },
    city: { type: "string", description: "City / locality." },
    region: { type: "string", description: "State / province / region code." },
    postal_code: { type: "string", description: "ZIP / postal code." },
    country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. US." },
  },
} as const;

export const FACET_DISCOVER_TOOL: FacetMcpToolDefinition = {
  name: "facet_discover",
  description:
    "Search the Facet Universal Business Index (the cross-merchant directory) for businesses matching a query, location, industry, or capability. Returns ranked listings, each with the business's Terminal URL so you can enter it with facet_get_merchant. Use this first to find who to buy from.",
  annotations: READ_ONLY_OPEN_WORLD,
  requiresIdentity: false,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language or keyword search over business name and taxonomy.",
      },
      near: {
        type: "object",
        description:
          "Geographic search center. When set, results carry distance and proximity feeds ranking.",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
        },
      },
      radius_km: {
        type: "number",
        description: "Search radius in kilometers (only applied with `near`).",
      },
      naics: {
        type: "array",
        items: { type: "integer" },
        description: "NAICS industry codes; a listing matches if its NAICS is any of these.",
      },
      taxonomy: {
        type: "array",
        items: { type: "string" },
        description: "Facet taxonomy / capability tags to overlap-match.",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "Capability tags; folded into the taxonomy overlap filter.",
      },
      min_reputation: { type: "number", description: "Minimum aggregate reputation score." },
      claimed_only: {
        type: "boolean",
        description: "Only return businesses with a claimed, live Terminal.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Page size (default 20, capped at 50).",
      },
      offset: { type: "integer", minimum: 0, description: "Page offset for pagination." },
    },
  },
};

export const FACET_GET_MERCHANT_TOOL: FacetMcpToolDefinition = {
  name: "facet_get_merchant",
  description:
    "Enter a merchant's Terminal and read its public profile: capabilities, terms, accepted payment rails, and whether it exposes a catalog. Accepts a domain, a terminal_url from facet_discover, or a ubi_id. Call this before searching or quoting so you know what the merchant supports.",
  annotations: READ_ONLY_OPEN_WORLD,
  requiresIdentity: false,
  inputSchema: {
    type: "object",
    required: ["merchant"],
    properties: {
      merchant: {
        type: "string",
        description:
          "The merchant to enter: a domain (acme.com), a terminal_url, or a ubi_id from facet_discover.",
      },
      capability_check: {
        type: "array",
        items: { type: "string" },
        description: 'Optional capabilities to assert the merchant advertises (e.g. ["catalog"]).',
      },
      refresh: {
        type: "boolean",
        description: "Bypass the in-session connection cache and re-fetch.",
      },
    },
  },
};

export const FACET_SEARCH_PRODUCTS_TOOL: FacetMcpToolDefinition = {
  name: "facet_search_products",
  description:
    "Search a single merchant's product catalog. Requires your Facet KYA identity (the merchant sees who is asking). Returns products with pricing and availability. Enter the merchant with facet_get_merchant first.",
  annotations: READ_ONLY_OPEN_WORLD,
  requiresIdentity: true,
  inputSchema: {
    type: "object",
    required: ["merchant"],
    properties: {
      merchant: { type: "string", description: "Merchant domain, terminal_url, or ubi_id." },
      query: { type: "string", description: "Free-text product search query." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max products to return (default 20).",
      },
      cursor: { type: "string", description: "Pagination cursor from a prior response." },
    },
  },
};

export const FACET_QUOTE_TOOL: FacetMcpToolDefinition = {
  name: "facet_quote",
  description:
    "Get a landed quote (goods + shipping + tax) for a product from a merchant, shipped to an address. Requires your Facet KYA identity. Returns the total, currency, and a quote_token you can later use to reserve and pay (payment is not part of this read-only tool).",
  annotations: READ_ONLY_OPEN_WORLD,
  requiresIdentity: true,
  inputSchema: {
    type: "object",
    required: ["merchant", "product_id", "ship_to"],
    properties: {
      merchant: { type: "string", description: "Merchant domain, terminal_url, or ubi_id." },
      product_id: { type: "string", description: "Product id from facet_search_products." },
      qty: { type: "integer", minimum: 1, description: "Quantity (default 1)." },
      ship_to: SHIP_TO_SCHEMA,
    },
  },
};

/** The four cross-merchant Facet MCP tools, in the order an agent uses them.
 *  Registered by both the local stdio server and the hosted network endpoint. */
export const FACET_MCP_TOOLS: readonly FacetMcpToolDefinition[] = [
  FACET_DISCOVER_TOOL,
  FACET_GET_MERCHANT_TOOL,
  FACET_SEARCH_PRODUCTS_TOOL,
  FACET_QUOTE_TOOL,
];
