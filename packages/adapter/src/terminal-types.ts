// Facet Terminal wire-contract types.
//
// Single source of truth for the error envelope + tool request/response
// shapes that flow between agents and a Facet Terminal. Consumed by:
//   - the Facet Terminal — server-side handler definitions
//   - the client SDK     — request builders and response parsers
//   - third-party SDKs   — anyone importing @facet-llc/adapter
//
// Protocol version tracked by `FACET_PROTOCOL_VERSION` below. Breaking
// changes bump the major segment; backwards-compatible additions bump the
// minor. Agents pin via the `Accept: application/vnd.facet+json; version=X.Y`
// header (enforced by the Terminal).

// 0.2.0: additive expansion bringing full typed-route coverage. New
// per-primitive type modules (booking-types, subscription-types,
// rfq-types, auction-types, graph-types, payment-dispatch-types,
// stripe-types, verify-domain-types) plus supplementary route types
// appended below. No existing exports changed.
export const FACET_PROTOCOL_VERSION = "0.2.0";

// MCP protocol-version support for the Terminal's /ucp/mcp endpoint. That server
// is DUAL-ERA: it implements the 2026-07-28 stateless revision AND still serves
// 2025-06-18 clients through the 12-month deprecation window. MCP_LATEST_VERSION
// is what a version-less caller and the agents.txt MCP-Protocol line advertise;
// MCP_SUPPORTED_VERSIONS is the set server/discover returns and the per-request
// negotiator accepts (newest first). MCP_PROTOCOL_VERSION stays exported as an
// alias to the latest for existing importers.
//
// NOTE: this is the LIVE Terminal's version. The starter-kit emitter keeps its
// OWN copy (packages/schema-generator-core/src/emit.ts), deliberately pinned to
// 2025-06-18 because generated kits are minimal and do not implement the
// stateless negotiation, so they must not claim a compliance level they lack.
export const MCP_LATEST_VERSION = "2026-07-28";
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_LATEST_VERSION, "2025-06-18"];
export const MCP_PROTOCOL_VERSION = MCP_LATEST_VERSION;

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope
// ─────────────────────────────────────────────────────────────────────────────

export type FacetErrorCode =
  // auth
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CAPABILITY_NOT_GRANTED"
  // client
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "VERSION_NOT_SUPPORTED"
  | "METHOD_NOT_ALLOWED"
  // throttling
  | "RATE_LIMITED"
  // domain
  | "INVENTORY_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "ALLERGEN_CONFLICT"
  | "SETTLEMENT_FAILED"
  // fulfillment
  | "FULFILLMENT_REQUIRED"
  | "UNDELIVERABLE"
  // server
  | "INTERNAL_ERROR";

export interface FacetErrorSuggest {
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly doc?: string;
  readonly upgrade?: string;
  // Issuer signup URL — surfaced on UNAUTHORIZED (missing Bearer or
  // untrusted issuer) and the WAF's 402 block body so an unauthenticated
  // agent can onboard without an out-of-band lookup. Typically points at
  // the sole trusted KYA issuer's register endpoint with a referral tag
  // (e.g. `?ref=facet`). Operators override per-deployment via
  // FACET_ISSUER_SIGNUP_URL.
  readonly signup?: string;
}

export interface FacetErrorBody {
  readonly code: FacetErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retry_after_seconds: number | null;
  readonly suggest: FacetErrorSuggest | null;
}

export interface FacetErrorEnvelope {
  readonly error: FacetErrorBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit state (X-Facet-RateLimit-* headers)
// ─────────────────────────────────────────────────────────────────────────────

export interface FacetRateLimitState {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number; // unix seconds
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta / discovery endpoints
// ─────────────────────────────────────────────────────────────────────────────

export interface VersionResponse {
  readonly facet: string;
  readonly mcp_protocol_version: string;
  readonly terminal: string;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly timestamp: string;
}

// GET /v1/ready — readiness probe. Distinct from /v1/health (liveness):
// it checks that the Terminal's critical dependencies are reachable.
// 200 { status: "ready" } when every critical check is "ok"; 503
// { status: "not_ready" } when any critical check is "fail". `checks`
// maps each probed dependency to its outcome — `supabase` is always
// present; others may be added as more critical deps are wired.
export type ReadyCheckStatus = "ok" | "fail";

export interface ReadyResponse {
  readonly status: "ready" | "not_ready";
  readonly timestamp: string;
  readonly checks: {
    readonly supabase: ReadyCheckStatus;
    readonly [dependency: string]: ReadyCheckStatus;
  };
}

export interface CapabilityDisabledEntry {
  readonly name: string;
  readonly upgrade?: string;
}

export interface CapabilitiesResponse {
  readonly facet: string;
  readonly tools: readonly string[];
  // Tools that exist in this Terminal's build but are not enabled on this
  // site. Present only when the operator has gated one or more tools
  // behind a tier / ToS acceptance / pricing change. Agents can read
  // `disabled_tools[].upgrade` to surface an upgrade CTA.
  readonly disabled_tools?: readonly CapabilityDisabledEntry[];
  readonly commerce: {
    readonly search: boolean;
    readonly quote: boolean;
    readonly reserve: boolean;
    readonly settle: boolean;
  };
  readonly webhooks: boolean;
  // The set of event kinds a subscriber can register against via
  // `POST /v1/subscribe_webhook`. Mirrors `WEBHOOK_EVENTS` from this
  // package. Absent on pre-Phase-8 terminals — subscribers should treat
  // missing as "unknown, best to hardcode against WEBHOOK_EVENTS."
  readonly webhook_events?: readonly WebhookEvent[];
  readonly content_licensing: boolean;
  readonly response_signing: boolean;
  // Fulfillment-primitive posture, so an agent discovers the ship-to
  // requirement BEFORE it tries to buy. `required_for_physical` true ⇒ a
  // `physical` SKU's quote needs a `fulfillment` destination or it's rejected.
  // `modes` lists the accepted FulfillmentInput.mode values (e.g. inline +
  // ref now, ciphertext once blind-courier ships). Absent on terminals
  // predating the primitive — treat as "no fulfillment enforcement."
  readonly fulfillment?: {
    readonly enabled: boolean;
    readonly required_for_physical: boolean;
    readonly modes: readonly ("inline" | "ref" | "ciphertext")[];
  };
  // UCP checkout posture, present only when the operator enables UCP
  // (FACET_UCP_ENABLED). Advertises the checkout-session surface as the
  // default agent entrypoint; the four verbs stay the primitive it composes.
  // Absent on a UCP-disabled terminal, so the payload is byte-identical there.
  readonly checkout?: {
    readonly enabled: boolean;
    readonly protocol: "ucp";
    readonly entrypoint: string;
    readonly complete: string;
    readonly redeem: string;
  };
  readonly rate_limits: {
    readonly default: { readonly requests_per_hour: number };
  };
}

// Bonded (Tier 2) buyer-protection posture, advertised on /v1/terms,
// /integrations.json, and agents.txt when a merchant has a funded bond
// account in the Facet buyer-protection bond contract. DISCOVERY-ONLY: this
// advertises a substantiated on-chain posture, it moves no money. Every field
// is backed by a live `getBond(merchant)` read at request time. A site is
// only advertised as bonded when its bond balance is greater than zero, and
// `coverage_available` is the live slashable-minus-locked amount. Absent
// means the merchant is not bonded (or the bond rail is not configured / the
// read failed), and the whole block is omitted rather than under- or
// over-claimed.
export interface BuyerProtectionBonded {
  // The tier label. Only "bonded" today; a discriminant for future tiers.
  readonly tier: "bonded";
  // The Facet buyer-protection bond contract address (one deployed contract;
  // each merchant has an account inside it keyed by their payout address).
  readonly bond_address: string;
  // eip155:<chainId> network the bond contract lives on (e.g. eip155:8453).
  readonly network: string;
  // Live available coverage = bond balance minus the amount locked for open
  // disputes, as a decimal USDC string (the bonded asset is USDC). Never
  // negative; "0" when the full balance is currently locked.
  readonly coverage_available: string;
}

export interface TermsResponse {
  readonly facet: string;
  // Bonded buyer-protection posture, present only when this site has a funded
  // bond account (see BuyerProtectionBonded). Absent on every terminal where
  // the bond rail is unconfigured or the merchant is unbonded, so the terms
  // payload is byte-identical to before wherever nothing is bonded.
  readonly buyer_protection?: BuyerProtectionBonded;
  readonly pricing: {
    readonly query_usdc: number;
    readonly transactional_usdc: number;
    readonly settlement_rails: readonly string[];
  };
  readonly rate_limits: {
    readonly default: { readonly requests_per_hour: number };
    readonly burst_policy: string;
  };
  readonly sla: {
    readonly read_p95_ms: number;
    readonly transactional_p95_ms: number;
    readonly uptime_target_monthly: string;
  };
  readonly data_use: {
    readonly retention_hot_days: number;
    readonly retention_warm_days: number;
    readonly retention_cold_days: number;
    readonly agent_visible_fields: readonly string[];
  };
  readonly support: {
    readonly contact: string;
    readonly escalate_via: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// search_products — POST /v1/search
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchRequest {
  readonly query?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}

// Wholesale-pricing shape. `per_case` is the baseline (qty=1+). Optional
// `tiers` apply case-pack volume discounts: the highest-min_qty tier
// whose threshold the quote meets wins. Tiers should be sorted
// ascending by `min_qty` at the source; Terminal re-sorts defensively.
export interface PricingTier {
  readonly min_qty: number;
  readonly per_case: number;
}

export interface PricingSchedule {
  readonly currency: string;
  readonly per_case: number;
  readonly tiers?: readonly PricingTier[];
}

export interface SearchProductResult {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  // SKU kind, so an agent knows pre-quote whether this buy will need a
  // ship-to destination. Absent ⇒ treated as `physical` once enabled.
  readonly kind?: SkuKind;
  readonly tags: readonly string[];
  readonly pricing: PricingSchedule;
  readonly pack: { readonly case_pack: number; readonly uom: string };
  readonly in_stock: boolean;
}

export interface SearchResponse {
  readonly results: readonly SearchProductResult[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fulfillment primitive (ship-to / delivery address)
//
// Physical goods need a destination: it determines landed cost (shipping +
// tax + duty) and deliverability, so it binds at QUOTE, carries through
// reserve, and freezes onto the Order at settle. The destination is NEVER
// stored on the order as plaintext PII — only an opaque `fulfillment_ref`
// (Phase 1, vaulted) or sealed `ciphertext` (Phase 2, blind-courier) does.
// These types are additive + optional so the surface ships dark until the
// fulfillment gate is wired.
// ─────────────────────────────────────────────────────────────────────────────

// What a SKU is, which decides whether a destination is required. Only
// `physical` requires fulfillment; `digital` / `service` (licenses, paywalled
// content, bookings) never force an address. Absent ⇒ treated as `physical`
// once the primitive is enabled (the safe default for a goods merchant).
export type SkuKind = "digital" | "physical" | "service";

// A structured, validated destination — never free-text, so deliverability is
// a precondition rather than a hope. `region` is ISO 3166-2, `country` is ISO
// 3166-1 alpha-2. `phone` is for carrier delivery notification only.
export interface ShippingTarget {
  readonly recipient: string;
  readonly line1: string;
  readonly line2?: string;
  readonly locality: string;
  readonly region: string;
  readonly postal_code: string;
  readonly country: string;
  readonly phone?: string;
}

// How the agent supplies the destination. `inline` = raw address (MVP; the
// Terminal validates → vaults → swaps for a ref). `ref` = a `fulfillment_ref`
// from a prior validation. `ciphertext` = blind-courier: the address sealed to
// the merchant's published fulfillment key (`kid`), which Facet relays but
// cannot read. Exactly one of address / fulfillment_ref / ciphertext is set,
// matching `mode`.
export interface FulfillmentInput {
  readonly mode: "inline" | "ref" | "ciphertext";
  readonly address?: ShippingTarget;
  readonly fulfillment_ref?: string;
  readonly ciphertext?: string;
  readonly kid?: string;
}

// A shipment posted back onto the Order once the merchant fulfills it (carried
// in from the Shopify `fulfillments/create` webhook → `order.shipped`).
export interface Shipment {
  readonly carrier: string;
  readonly tracking_number: string;
  readonly eta?: string; // ISO 8601
}

// ─────────────────────────────────────────────────────────────────────────────
// quote_product — POST /v1/quote
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteAmountInUom {
  readonly amount: number;
  readonly unit: string; // mass: mg / g / kg / oz / lb | volume: ml / l / fl-oz / cup / pt / qt / gal
}

export interface QuoteRequest {
  readonly product_id: string;
  // Direct case count — wholesale-native. Use this when the buyer
  // already thinks in cases. Mutually exclusive with `qty_in_uom`.
  readonly qty?: number;
  // Alternate input: amount + unit in the buyer's natural UoM. The
  // Terminal converts to cases using the product's `pack.uom`,
  // rounding cases UP so the delivered amount is always ≥ requested.
  // The conversion is same-family only (mass↔mass, volume↔volume);
  // cross-family (e.g. lb → fl-oz) returns INVALID_REQUEST.
  readonly qty_in_uom?: QuoteAmountInUom;
  // Multi-line cart (additive). When present, the quote prices EVERY line
  // (DISTINCT product_ids, server-derived per-line from the catalog) and returns
  // ONE summed subtotal, one shipping, and tax on the summed goods, sealing every
  // line into the quote_token. The scalar `product_id` stays REQUIRED and names
  // the first line for back-compat; a caller that sends only the scalar keeps the
  // legacy single-line behavior. One order-level `fulfillment` covers the whole
  // cart. Each entry carries its own `qty` OR `qty_in_uom`, never both.
  readonly line_items?: readonly {
    readonly product_id: string;
    readonly qty?: number;
    readonly qty_in_uom?: QuoteAmountInUom;
  }[];
  // F&B allergen-avoidance list. Quote fails with `ALLERGEN_CONFLICT`
  // if the product's declared allergens intersect (case-insensitive,
  // after underscore/hyphen/space normalization). Agents use this to
  // honor buyer-facing dietary constraints without falling back to
  // post-quote inspection.
  readonly exclude_allergens?: readonly string[];
  // Ship-to destination. REQUIRED for a `physical` SKU once the fulfillment
  // primitive is enabled — quote rejects with FULFILLMENT_REQUIRED if absent,
  // or UNDELIVERABLE if the address validates but can't ship. Bound into the
  // quote_token so it can't be swapped between quote and settle. Omit for
  // digital/service SKUs. (Additive — ignored while the primitive ships dark.)
  readonly fulfillment?: FulfillmentInput;
}

export interface QuoteResponse {
  readonly quote_token: string;
  readonly product_id: string;
  readonly qty: number;
  readonly unit_price: number;
  // Summed goods subtotal across every line (== unit_price * qty for a single
  // line). For a multi-line cart it is the sum of the per-line subtotals.
  readonly subtotal: number;
  // The priced cart. Present with more than one entry only for a multi-line
  // quote; a single-line quote returns a one-element array (or omits it for
  // legacy callers that read the scalar fields). Every price is server-derived.
  readonly line_items?: readonly OrderLineItem[];
  readonly currency: string;
  readonly expires_at: string; // ISO 8601
  // Landed-cost breakdown for a physical SKU, computed against the bound
  // destination by the merchant's own engine (Shopify Draft Order). Present
  // only when the quote carried a fulfillment destination. `total_landed` =
  // subtotal + shipping + tax + duty — the amount that will be charged at
  // settle. `fulfillment_ref` is the opaque handle to the vaulted destination
  // (never the address itself).
  readonly shipping?: number;
  readonly tax?: number;
  readonly duty?: number;
  readonly total_landed?: number;
  readonly delivery_estimate?: string; // ISO 8601 date or window
  readonly fulfillment_ref?: string;
  // When a case-pack pricing tier applied, the selected tier. Omitted
  // when the quote used the baseline `per_case` (no tiers on the
  // product OR qty below every tier threshold).
  readonly applied_tier?: PricingTier;
  // When the agent requested in a non-case UoM and the Terminal
  // converted, the actual delivered amount in the product's pack
  // UoM. Present when the request used `qty_in_uom`.
  readonly delivered_in_uom?: { readonly amount: number; readonly unit: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// reserve — POST /v1/reserve
// ─────────────────────────────────────────────────────────────────────────────

export interface ReserveRequest {
  readonly quote_token: string;
}

export interface ReserveResponse {
  readonly reservation_id: string;
  readonly product_id: string;
  readonly qty: number;
  readonly unit_price: number;
  readonly total: number;
  readonly currency: string;
  readonly status: "reserved";
  readonly expires_at: string;
  readonly kya_charge_url: string | null;
  // Present ONLY on a stripe_deposit settlement-venue site: the per-order Stripe
  // deposit address the agent must pay the x402 (ERC-3009) to for THIS reservation,
  // instead of the site's statically advertised payTo. A per-order address cannot be
  // advertised statically, so it rides here. Absent for a normal on-chain site (the
  // payTo comes from discovery), which is why it is optional and additive.
  readonly pay_to?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel_reservation — POST /v1/cancel_reservation
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelReservationRequest {
  readonly reservation_id: string;
}

export interface CancelReservationResponse {
  readonly reservation_id: string;
  readonly status: "cancelled";
  readonly cancelled_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reservations CRUD — get_reservation / list_reservations / extend_reservation
//
// Read + lifecycle ops over the caller's own reservations. All three are
// owner-scoped (KYA bearer): a reservation belonging to a different agent
// reads back as FORBIDDEN/NOT_FOUND, never leaks. `Reservation` is the
// shared wire shape these return — timestamps are ISO 8601, mirroring
// ReserveResponse / Order.
// ─────────────────────────────────────────────────────────────────────────────

export type ReservationStatus = "reserved" | "cancelled" | "expired" | "settled";

export interface Reservation {
  readonly reservation_id: string;
  readonly product_id: string;
  readonly qty: number;
  readonly unit_price: number;
  readonly total: number;
  readonly currency: string;
  readonly status: ReservationStatus;
  readonly created_at: string; // ISO 8601
  readonly expires_at: string; // ISO 8601
}

export interface GetReservationRequest {
  readonly reservation_id: string;
}

export type GetReservationResponse = Reservation;

export interface ListReservationsRequest {
  // Optional lifecycle filter; omit for all statuses.
  readonly status?: ReservationStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListReservationsResponse {
  readonly reservations: readonly Reservation[];
  readonly next_cursor: string | null;
}

export interface ExtendReservationRequest {
  readonly reservation_id: string;
  // New absolute expiry as ISO 8601. Must be in the future and later
  // than the current expiry — the Terminal only ever bumps a hold
  // forward, never shortens it.
  readonly expires_at: string;
}

export type ExtendReservationResponse = Reservation;

// ─────────────────────────────────────────────────────────────────────────────
// Discovery — get_product / get_document
//
// get_product surfaces richer detail than the search summary (description,
// origin, HTS, document references). get_document returns metadata + a
// URL the agent can fetch the file from.
// ─────────────────────────────────────────────────────────────────────────────

export type DocumentKind = "coa" | "sds" | "spec_sheet" | "label" | "other";

export interface Document {
  readonly document_id: string;
  readonly product_id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly url: string;
  readonly mime_type: string;
  readonly size_bytes: number | null;
  readonly issued_at: string | null; // ISO 8601
  readonly expires_at: string | null;
}

export interface GetDocumentRequest {
  readonly document_id: string;
}

export type GetDocumentResponse = Document;

// ─────────────────────────────────────────────────────────────────────────────
// Operator document CRUD — create / update / delete / list_document.
//
// OPERATOR-scoped (not agent tools): the caller is a site member, the
// request body carries `site_id`, and the Terminal authorizes via
// requireSiteRole (admin for writes, viewer for list) before any store
// work. Cross-site isolation: documents are bound to products, products
// belong to a site; an operator may only touch documents whose product is
// in their own site. The agent-facing get_document above is the read
// sibling.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDocumentRequest {
  readonly site_id: string;
  // The product this document is attached to. MUST belong to `site_id`.
  readonly product_id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly url: string;
  readonly mime_type: string;
  readonly size_bytes?: number | null;
  readonly issued_at?: string | null; // ISO 8601
  readonly expires_at?: string | null; // ISO 8601
}

export type CreateDocumentResponse = Document;

export interface UpdateDocumentRequest {
  readonly site_id: string;
  readonly document_id: string;
  // Patch — only the provided fields change. product_id is NOT patchable.
  readonly kind?: DocumentKind;
  readonly title?: string;
  readonly url?: string;
  readonly mime_type?: string;
  readonly size_bytes?: number | null;
  readonly issued_at?: string | null;
  readonly expires_at?: string | null;
}

export type UpdateDocumentResponse = Document;

export interface DeleteDocumentRequest {
  readonly site_id: string;
  readonly document_id: string;
}

export interface DeleteDocumentResponse {
  readonly document_id: string;
  readonly deleted: true;
}

export interface ListDocumentRequest {
  readonly site_id: string;
  // Optional: narrow the listing to one product.
  readonly product_id?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListDocumentResponse {
  readonly documents: readonly Document[];
  readonly next_cursor: string | null;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  // What kind of SKU this is — decides whether a buy requires a ship-to
  // destination. `physical` requires fulfillment; `digital`/`service` are
  // exempt. Absent ⇒ treated as `physical` once the primitive is enabled.
  readonly kind?: SkuKind;
  readonly description: string | null;
  readonly origin: string | null;
  readonly hts_code: string | null;
  readonly allergens: readonly string[];
  readonly tags: readonly string[];
  readonly pricing: PricingSchedule;
  readonly pack: { readonly case_pack: number; readonly uom: string };
  readonly in_stock: boolean;
  readonly inventory: number; // cases available right now
  readonly coa_available: boolean;
  readonly document_ids: readonly string[];
}

export interface GetProductRequest {
  readonly product_id: string;
}

export type GetProductResponse = Product;

// ─────────────────────────────────────────────────────────────────────────────
// get_compliance — F&B-specific tool.
//
// Aggregates the three compliance surfaces a food buyer cares about:
//   1. Allergen declarations (FALCPA Top 9 + FASTER sesame → 10 priority allergens)
//      plus "may contain" statements from shared-line processing.
//   2. FSMA 204 traceability posture — whether the product is on the Food
//      Traceability List (FTL), what lot-code format Facet can emit, and
//      which Key Data Elements / Critical Tracking Events the supplier
//      currently surfaces.
//   3. Third-party certifications — Organic / Non-GMO / Kosher / Halal /
//      Vegan / Fair Trade / GF / Rainforest Alliance — with supporting
//      document references when known.
//
// The response shape is additive to get_product; agents call this when a
// downstream buyer specifically asks "can you prove X" (allergen protocol,
// traceability audit, cert renewal), without re-fetching the full catalog
// record. The response synthesizes compliance data from the Product
// record's `allergens` + `tags` + `document_ids` fields.

export interface ComplianceCertification {
  readonly name: string;
  readonly issued_by: string | null;
  readonly valid_until: string | null; // ISO 8601 date or null if unknown
  readonly document_id: string | null; // document_id when the cert PDF is available
}

export interface ComplianceDocument {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
}

export interface ProductCompliance {
  readonly product_id: string;
  readonly allergens: {
    readonly declared: readonly string[];
    readonly may_contain: readonly string[];
  };
  readonly fsma_204: {
    readonly ftl_listed: boolean;
    readonly lot_code_format: string | null;
    readonly kde_support: readonly string[];
    readonly cte_support: readonly string[];
  };
  readonly certifications: readonly ComplianceCertification[];
  readonly documents: readonly ComplianceDocument[];
}

export interface GetComplianceRequest {
  readonly product_id: string;
}

export type GetComplianceResponse = ProductCompliance;

// ─────────────────────────────────────────────────────────────────────────────
// Operator compliance-override CRUD —
//   create / update / delete / list_compliance.
//
// OPERATOR-scoped (not agent tools): the caller is a site member, the
// request body carries `site_id`, and the Terminal authorizes via
// requireSiteRole (admin for writes, viewer for list) before any store
// work. These manage the supplier-attested overrides that get_compliance
// (above) merges onto the fixture-derived baseline. The override is keyed
// by (site_id, product_id) — one override per product — so create conflicts
// if one already exists; update/delete address an existing one.
//
// Cross-site isolation: overrides are keyed by product_id and products
// belong to a site; an operator may only CRUD overrides for their own
// site's products. A cross-site product/override reads back as NOT_FOUND.
// ─────────────────────────────────────────────────────────────────────────────

// The override resource as returned by the operator routes. `may_contain`
// + `certifications` are always present (defaulting to empty); the FSMA 204
// fields are nullable — `null` means "defer to the Terminal's
// category-inferred default" in get_compliance.
export interface ComplianceOverride {
  readonly product_id: string;
  readonly may_contain: readonly string[];
  readonly certifications: readonly ComplianceCertification[];
  readonly ftl_listed: boolean | null;
  readonly lot_code_format: string | null;
  readonly kde_support: readonly string[] | null;
  readonly cte_support: readonly string[] | null;
}

export interface CreateComplianceRequest {
  readonly site_id: string;
  // The product this override applies to. MUST belong to `site_id`.
  readonly product_id: string;
  readonly may_contain?: readonly string[];
  readonly certifications?: readonly ComplianceCertification[];
  readonly ftl_listed?: boolean | null;
  readonly lot_code_format?: string | null;
  readonly kde_support?: readonly string[] | null;
  readonly cte_support?: readonly string[] | null;
}

export type CreateComplianceResponse = ComplianceOverride;

export interface UpdateComplianceRequest {
  readonly site_id: string;
  readonly product_id: string;
  // Patch — only the provided fields change. product_id is NOT patchable.
  readonly may_contain?: readonly string[];
  readonly certifications?: readonly ComplianceCertification[];
  readonly ftl_listed?: boolean | null;
  readonly lot_code_format?: string | null;
  readonly kde_support?: readonly string[] | null;
  readonly cte_support?: readonly string[] | null;
}

export type UpdateComplianceResponse = ComplianceOverride;

export interface DeleteComplianceRequest {
  readonly site_id: string;
  readonly product_id: string;
}

export interface DeleteComplianceResponse {
  readonly product_id: string;
  readonly deleted: true;
}

export interface ListComplianceRequest {
  readonly site_id: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListComplianceResponse {
  readonly overrides: readonly ComplianceOverride[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commerce — settle / get_order / order_history
//
// settle is KYAPay-delegated — Facet does not run the money rail. The agent
// reaches KYAPay for the `charge` API; Facet flips the reservation to
// 'settled' and emits a signed order row referencing the kya_charge_id.
// ─────────────────────────────────────────────────────────────────────────────

// Order lifecycle. `settled` is the entry state (set by /v1/settle). The
// state machine in update_order / cancel_order advances it:
//   settled  → fulfilled | cancelled
//   fulfilled | cancelled → terminal (no legal transition out)
// Financial fields (amount, currency, rail, kya_charge_id, line_items)
// are immutable once settled — only `status` advances. `cancelled` is a
// pre-fulfillment cancel; `fulfilled` marks shipment/delivery.
//
// `refunded` is NOT reachable via update_order. It is owned by the
// adjudicated refund pipeline (refund_request → merchant decision → money
// movement), which tracks state on a separate Refund ticket; an order being
// refunded does not move through this map.
export type OrderStatus = "settled" | "fulfilled" | "refunded" | "cancelled";

export interface OrderLineItem {
  readonly product_id: string;
  readonly qty: number;
  readonly unit_price: number;
  readonly subtotal: number;
}

export interface Order {
  readonly order_id: string;
  readonly reservation_id: string;
  readonly status: OrderStatus;
  readonly amount: number;
  readonly currency: string;
  readonly rail: string | null;
  readonly kya_charge_id: string | null;
  readonly line_items: readonly OrderLineItem[];
  readonly created_at: string;
  readonly settled_at: string | null;
  // Opaque handle to the vaulted ship-to destination — NEVER the raw address.
  // Present on physical-goods orders once the fulfillment primitive is live;
  // only the merchant-scoped, service-role write-back path can resolve it.
  readonly fulfillment_ref?: string;
  // Shipments posted back by the merchant's `fulfillments/create` webhook
  // (→ `order.shipped`). Empty/absent until the order is fulfilled.
  readonly shipments?: readonly Shipment[];
}

// Buyer-supplied, agent-passable order attributes, threaded from settle into
// the merchant order (gift_message → order note; delivery_date + occasion →
// order meta). All optional; NONE participate in pricing — the charged amount
// is always derived server-side from the reservation.
export interface OrderAttributes {
  readonly gift_message?: string;
  readonly delivery_date?: string; // ISO date, YYYY-MM-DD
  readonly occasion?: string;
}

export interface SettleRequest {
  readonly reservation_id: string;
  // Optional buyer-supplied order attributes (gift message, delivery date,
  // occasion). Carried into the merchant order; never read for pricing.
  readonly order_attributes?: OrderAttributes;
  // Optional KYAPay `charge` proof. When provided, the Terminal MAY verify
  // it against the calling agent + reservation total; when absent, dev-mode
  // synthesizes a placeholder charge id. Real KYAPay integration replaces
  // this field's contract without a wire-shape change.
  readonly kya_charge_token?: string;
  // Optional settlement-rail hint: "usdc-base" | "visa" | "mc" | ...
  // KYAPay picks the rail via its `stp` claim; this is informational.
  readonly rail?: string;
  // Optional rail-specific settlement authority artifact, threaded
  // verbatim to the payment-rail adapter's `capture` when the Terminal
  // has a PaymentDispatcher wired and the chosen rail is a dispatcher
  // rail. Shapes are rail-specific (opaque to the wire contract):
  //   - x402 (coin/usdc-base*): `{ x_payment: <base64 X-PAYMENT header> }`
  //     — the buyer's EIP-3009 USDC authorization, captured one-shot.
  //   - Boson escrow (coin/boson-escrow): `{ exchange_id, signed_payload }`
  //     — the buyer's boson-redeem meta-tx, redeemed against the escrow
  //     committed earlier (quote → commit precursor required).
  // SECURITY: the charge AMOUNT is NEVER read from this field (or anywhere
  // in the settle body) — it is derived server-side from the reservation /
  // order. This field only carries the cryptographic authorization, never
  // the price.
  // REQUIRED on any Terminal that has a payment rail configured, which is
  // every production deployment: such a Terminal REFUSES a settle that omits
  // this field (INVALID_REQUEST), and a `kya_charge_token` is NOT a substitute
  // (it is an unverified opaque string and was never a settlement proof).
  // Absent only on a Terminal with no rail wired (dev/test harnesses), which
  // keeps the dev-synth charge-id path.
  readonly authority?: Record<string, unknown>;
}

export type SettleResponse = Order;

// UCP checkout: POST /ucp/v1/checkout-sessions (create) then
// POST /ucp/v1/checkout-sessions/complete. This is the agent-facing checkout
// envelope; the four-verb primitives (quote/reserve/settle) still power
// settlement underneath it. v1 reserves a cart of DISTINCT server-priced line
// items and advertises the llc.facet.x402 requirements; every price is derived
// server-side from the merchant catalog, never from the request body.
export interface CheckoutLineItem {
  readonly item: { readonly id: string };
  readonly quantity?: number;
}

export interface CheckoutCreateRequest {
  readonly line_items: readonly CheckoutLineItem[];
  // Optional UCP fulfillment. When it carries a shipping method with a
  // destination, the session is priced LANDED (goods plus shipping plus tax).
  // Open-shaped server-side (additionalProperties), so the SDK passes it through.
  readonly fulfillment?: Record<string, unknown>;
}

export interface CheckoutCreateResponse {
  // The checkout session id (the Terminal reservation id).
  readonly id: string;
  // Checkout status, e.g. "ready_for_complete".
  readonly status: string;
  // ISO 4217 currency of the priced line items.
  readonly currency?: string;
  // Server-resolved payment requirements keyed by handler id (e.g.
  // "llc.facet.x402"): network, USDC asset, pay_to, and the server-derived
  // amount. The buyer builds the payment instrument from this, never the body.
  readonly payment_handlers?: Record<string, unknown>;
}

// One entry in a checkout payment: either an x402_authorization (with `token`)
// or a boson_commit_authorization (with `x_payment` plus the seller-signed
// `requirements` echoed from CREATE). Shapes are rail-specific; the amount is
// NEVER read from here, it is re-derived server-side from the reservation.
export interface CheckoutCredential {
  readonly type: string;
  readonly token?: string;
  readonly x_payment?: string;
  readonly requirements?: unknown;
}

export interface CheckoutPaymentInstrument {
  readonly credential: CheckoutCredential;
}

export interface CheckoutPayment {
  readonly instruments: readonly CheckoutPaymentInstrument[];
}

export interface CheckoutCompleteRequest {
  // OPTIONAL when the /ucp/v1/checkout-sessions/{id}/complete path form is used
  // (the id comes from the path); required on the legacy body form.
  readonly checkout_id?: string;
  readonly payment: CheckoutPayment;
}

export interface CheckoutOrderRef {
  readonly id: string;
  readonly permalink_url?: string;
}

export interface CheckoutCompleteResponse {
  // Completion status, e.g. "completed".
  readonly status: string;
  readonly order?: CheckoutOrderRef;
  // The rail-native settlement id (the x402 on-chain tx hash), when settled.
  readonly settlement_id?: string;
  // ISO 8601 settlement timestamp, when available.
  readonly settled_at?: string;
}

export interface GetOrderRequest {
  readonly order_id: string;
}

export type GetOrderResponse = Order;

export interface OrderHistoryRequest {
  readonly since?: string; // ISO 8601
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OrderHistoryResponse {
  readonly orders: readonly Order[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// update_order / cancel_order — POST /v1/update_order, /v1/cancel_order
//
// Owner-scoped writes over the caller's own orders, guarded by a state
// machine (see OrderStatus). update_order advances `status` along a legal
// transition; cancel_order is the pre-fulfillment cancel shortcut. Both are
// agent-scoped (KYA bearer) — an order owned by another agent reads back as
// NOT_FOUND on get and is refused on write. Financial fields are immutable
// once settled; only the lifecycle status changes.
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateOrderRequest {
  readonly order_id: string;
  // Target lifecycle status. Must be a legal transition from the order's
  // current status; an illegal or terminal→other transition is rejected
  // with IDEMPOTENCY_CONFLICT. Re-asserting the current status is a no-op.
  readonly status: OrderStatus;
}

export type UpdateOrderResponse = Order;

export interface CancelOrderRequest {
  readonly order_id: string;
}

export type CancelOrderResponse = Order;

// ─────────────────────────────────────────────────────────────────────────────
// refund_request — POST /v1/refund_request
//
// Opens a refund ticket on a settled order. Site decides approval (admin
// tool). Facet does not execute the money rail — KYAPay owns
// that — so the tool is a state machine, not a ledger.
// ─────────────────────────────────────────────────────────────────────────────

export type RefundStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "fulfilled"
  // 3-A dispute resolver (money-inert terminal states):
  | "escalated"
  | "adjudicated";

/** One line of a partial-refund selection: refund `qty` units of the ordered
 *  `product_id`. A positive integer qty, at most the ordered qty. The taxed
 *  amount is DERIVED server-side from the merchant order at approval time; the
 *  selection never carries an amount, and the agent never names a destination. */
export interface RefundLineItem {
  readonly product_id: string;
  readonly qty: number;
}

export interface Refund {
  readonly refund_id: string;
  readonly order_id: string;
  readonly status: RefundStatus;
  readonly reason: string;
  readonly decision: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
  /** On-chain send-back tx hash once the refund is fulfilled; null until then. */
  readonly settlement_ref: string | null;
  /** True when the agent presented a valid signed settlement receipt for the order. */
  readonly receipt_verified: boolean;
  /** The partial-refund line selection, once one is set (advisory at request, the
   *  merchant-authoritative one at decide). null = a full-order refund. */
  readonly refund_line_items?: readonly RefundLineItem[] | null;
  /** The derived partial amount in cents, persisted at approval; null until a
   *  partial is approved (and always null for a full-order refund). */
  readonly amount_minor?: number | null;
}

export interface RefundRequestRequest {
  readonly order_id: string;
  readonly reason: string;
  /** Optional PARTIAL selection: refund only these [{product_id, qty}] lines
   *  instead of the whole order. Advisory at request time (the merchant is
   *  authoritative and may adjust it at decide); server-validated against the
   *  order (each product_id ordered, qty a positive integer at most the ordered
   *  qty). Omitted = a full-order refund (the unchanged behaviour). */
  readonly refund_line_items?: readonly RefundLineItem[];
  /** Optional Ed25519-signed settlement receipt (the signed settle response the
   *  agent received). When valid and bound to this order, sets receipt_verified. */
  readonly receipt?: {
    readonly body: string;
    readonly signature: string;
    readonly trace_id: string;
    readonly path?: string;
  };
}

export type RefundRequestResponse = Refund;

/** POST /v1/refund_decide body: a merchant/owner approve or reject of an agent
 *  refund ticket. site_id is derived from the ticket, never the body. On approve
 *  the merchant MAY carry a partial `refund_line_items` selection that overrides
 *  the agent's; omitted keeps whatever the ticket already carries. */
export interface RefundDecideRequest {
  readonly refund_id: string;
  readonly decision: "approved" | "rejected";
  readonly note?: string;
  readonly refund_line_items?: readonly RefundLineItem[];
}

// Dispute resolver (3-A): escalate / adjudicate. MONEY-INERT: a rejected refund
// can be escalated by its own agent, and a neutral Facet operator adjudicates on
// the signed, reconstructable audit trail. Enforcement is reputation only; no
// funds ever move (buyer make-whole is deferred to the bond, Tier 2).

/** POST /v1/refund_escalate: the disputing agent escalates its own REJECTED
 *  refund ticket for Facet adjudication. KYA-authed and bound to the ticket's own
 *  agent_aid (a different agent is forbidden). Money-inert. */
export interface RefundEscalateRequest {
  readonly refund_id: string;
  /** Optional additional context from the agent; advisory. */
  readonly note?: string;
}

export interface RefundEscalateResponse {
  readonly refund_id: string;
  readonly status: RefundStatus;
}

/** The outcome of a dispute ruling. */
export type DisputeRulingOutcome = "uphold_buyer" | "uphold_merchant";

/** POST /v1/refund_adjudicate: a neutral Facet operator rules on an ESCALATED
 *  dispute. Operator-authed (a shared adjudicator secret), NEITHER the merchant
 *  NOR the agent. The ruling is Ed25519-signed over the reconstructed audit trail
 *  and recorded immutably; uphold_buyer downgrades the merchant's reputation. */
export interface RefundAdjudicateRequest {
  readonly refund_id: string;
  readonly ruling: DisputeRulingOutcome;
  readonly rationale?: string;
}

/** The signed, immutably-recorded ruling returned by /v1/refund_adjudicate. */
export interface DisputeRuling {
  readonly refund_id: string;
  readonly order_id: string;
  readonly ruling: DisputeRulingOutcome;
  readonly rationale: string | null;
  /** keccak256 of the canonical evidence bundle (events + settle receipt + OMS record). */
  readonly evidence_hash: string;
  readonly arbiter_id: string;
  /** The canonical ruling body that was signed. */
  readonly ruling_body: string;
  /** Ed25519 signature over ruling_body, verifiable against the published JWKS. */
  readonly signature: string;
  readonly kid: string;
  /** The trace id bound into the signed canonical string; REQUIRED to reconstruct
   *  and independently verify the signature against the JWKS (method POST, path
   *  /v1/refund_adjudicate, this trace_id, sha256(ruling_body)). */
  readonly trace_id: string;
  readonly created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds CRUD — get_refund / list_refunds
//
// Read paths over the caller's own refund tickets. Both are owner-scoped
// (KYA bearer): a refund belonging to a different agent reads back as
// NOT_FOUND on get, and list is filtered to the caller's aid at the store
// layer so it never surfaces another agent's tickets. The wire shape is
// the shared `Refund` returned by refund_request.
// ─────────────────────────────────────────────────────────────────────────────

export interface GetRefundRequest {
  readonly refund_id: string;
}

export type GetRefundResponse = Refund;

export interface ListRefundsRequest {
  // Optional lifecycle filter; omit for all statuses.
  readonly status?: RefundStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListRefundsResponse {
  readonly refunds: readonly Refund[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// purchase_license (Content Licensing Marketplace)
//
// Agents pay a per-query price the publisher set, receiving a time-scoped,
// optionally usage-capped license. The receipt returned here is snapshotted
// — subsequent offer edits/retirements do NOT retroactively modify an
// outstanding license.
// ─────────────────────────────────────────────────────────────────────────────

export interface License {
  readonly license_id: string;
  readonly scope: string;
  readonly price_minor: number;
  readonly currency: string;
  readonly rail: string;
  readonly kya_charge_id: string | null;
  readonly purchased_at: string;
  readonly expires_at: string;
  readonly usage_count: number;
  readonly usage_limit: number | null;
  // Revocation timestamp (ISO 8601). Null on an active license; set by
  // POST /v1/revoke_license. A revoked license is permanently unusable —
  // consume_license rejects it with CAPABILITY_NOT_GRANTED even before
  // its expiry. Optional in the wire shape so existing receipts that
  // predate the revocation column stay valid.
  readonly revoked_at?: string | null;
  // Stripe destination-charge fields, populated when
  // the site has a Stripe Connect account + the Terminal has
  // STRIPE_SECRET_KEY wired. `stripe_client_secret` is the only
  // piece the agent's payment collection step needs; the others
  // are informational.
  readonly stripe_payment_intent_id?: string | null;
  readonly stripe_client_secret?: string | null;
  readonly stripe_application_fee_minor?: number | null;
  readonly stripe_status?: "pending" | "succeeded" | "failed" | "refunded" | null;
}

export interface PurchaseLicenseRequest {
  readonly scope: string;
  // Optional idempotency key. Re-submitting with the same value returns
  // the original license instead of charging again.
  readonly idempotency_key?: string;
}

export type PurchaseLicenseResponse = License;

export interface ConsumeLicenseRequest {
  readonly license_id: string;
}

export interface ConsumeLicenseResponse {
  readonly license_id: string;
  readonly scope: string;
  readonly usage_count: number;
  readonly usage_limit: number | null;
  readonly expires_at: string;
}

// ── Phase 2 tier-A2 — license CRUD over the caller's own receipts ──────────

export interface GetLicenseRequest {
  readonly license_id: string;
}

/** Owner-scoped read of one license receipt. A license owned by another
 *  agent reads back as NOT_FOUND so the surface never confirms its
 *  existence. */
export type GetLicenseResponse = License;

export interface ListLicensesRequest {
  // When true, include revoked receipts in the page. Default false —
  // active + expired receipts only.
  readonly include_revoked?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListLicensesResponse {
  readonly licenses: readonly License[];
  readonly next_cursor: string | null;
}

export interface RevokeLicenseRequest {
  readonly license_id: string;
}

/** The revoked license receipt. `revoked_at` is now populated; a
 *  subsequent consume_license rejects with CAPABILITY_NOT_GRANTED. */
export type RevokeLicenseResponse = License;

// ─────────────────────────────────────────────────────────────────────────────
// catalog_changes_since(cursor)
//
// Agents cache the catalog locally and pull
// only deltas on each cycle. The cursor is base64-encoded JSON with a
// `(ts, id)` pair so duplicate-timestamp rows never get skipped —
// rows with equal `updated_at` break the tie on primary key order,
// and the next-cursor always anchors at the last row returned.
//
// Document and product deltas share one wire shape, so new change
// kinds are additive without a wire-shape change.
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogChangeKind =
  | "product"
  | "document"
  // emitted by the schema-generator CLI after each
  // upstream re-crawl. Signals a manifest-level regeneration (new
  // facet.yaml blob upserted into the site manifest store). Agents can treat
  // this as a hint to refetch /v1/schema and invalidate any cached
  // product list. `product_id` will be the empty string on manifest
  // events — they're whole-catalog, not SKU-scoped.
  | "manifest"
  | "price"
  | "inventory";
export type CatalogChangeAction = "added" | "updated" | "removed" | "restocked";

export interface CatalogChange {
  readonly kind: CatalogChangeKind;
  readonly action: CatalogChangeAction;
  readonly id: string; // document_id / product_id / catalog_change row id
  readonly product_id: string; // anchor so agents can invalidate product-scoped caches; empty string for kind='manifest'
  readonly updated_at: string; // ISO 8601
}

export interface CatalogChangesSinceRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CatalogChangesSinceResponse {
  readonly changes: readonly CatalogChange[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// webhooks — subscribe_webhook / list_webhooks / delete_webhook
//
// The agent registers callback URLs for the
// event kinds it cares about. The Terminal fans each event out with an
// HMAC-SHA256-signed POST:
//
//   X-Facet-Signature: t=<unix>,v1=<hex_hmac_sha256>
//
// where the HMAC is taken over `${t}.${request_body}` using the
// subscription's per-register shared secret (returned once at create
// time, never re-exposed). A future revision folds webhook signing into
// the Ed25519 response-signing envelope; subscribers will accept either
// during the transition window.
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookEvent =
  | "order.settled"
  | "order.shipped"
  | "order.refund_requested"
  | "price.changed"
  | "inventory.restocked"
  | "document.available"
  | "license.purchased"
  | "license.consumed"
  // Primitive 6 — Auction
  | "auction.bid_outbid"
  | "auction.ending_soon"
  | "auction.won"
  | "auction.lost"
  | "auction.ended_no_sale"
  // Primitive 4 — Booking
  | "booking.confirmed"
  | "booking.cancelled"
  // Primitive 3 — Subscription
  | "subscription.run_settled"
  | "subscription.run_failed"
  | "subscription.price_breaker_tripped"
  // Primitive 7 — RFQ
  | "rfq.quote_received"
  | "rfq.quote_accepted"
  | "rfq.cancelled";

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "order.settled",
  "order.shipped",
  "order.refund_requested",
  "price.changed",
  "inventory.restocked",
  "document.available",
  "license.purchased",
  "license.consumed",
  "auction.bid_outbid",
  "auction.ending_soon",
  "auction.won",
  "auction.lost",
  "auction.ended_no_sale",
  "booking.confirmed",
  "booking.cancelled",
  "subscription.run_settled",
  "subscription.run_failed",
  "subscription.price_breaker_tripped",
  "rfq.quote_received",
  "rfq.quote_accepted",
  "rfq.cancelled",
] as const;

export interface WebhookSubscription {
  readonly webhook_id: string;
  readonly events: readonly WebhookEvent[];
  readonly callback_url: string;
  readonly active: boolean;
  readonly created_at: string; // ISO 8601
}

export interface SubscribeWebhookRequest {
  readonly events: readonly WebhookEvent[];
  readonly callback_url: string;
}

// One-time reveal: the shared secret used to HMAC-sign deliveries.
// Clients MUST persist this at create time — subsequent list calls
// never re-expose it.
export interface SubscribeWebhookResponse extends WebhookSubscription {
  readonly secret: string;
}

export interface ListWebhooksResponse {
  readonly webhooks: readonly WebhookSubscription[];
}

export interface DeleteWebhookRequest {
  readonly webhook_id: string;
}

export interface DeleteWebhookResponse {
  readonly webhook_id: string;
  readonly deleted: true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook subscription CRUD — get_webhook / update_webhook
//
// Owner-scoped read + modify over the caller's own subscriptions. Both
// reuse the `WebhookSubscription` wire shape, which deliberately omits the
// `secret` — get never re-exposes it (only subscribe_webhook reveals it
// once) and update can never change it. update_webhook rewrites `events`
// and/or `callback_url` only; a subscription owned by another agent reads
// back as NOT_FOUND/FORBIDDEN, never leaks.
// ─────────────────────────────────────────────────────────────────────────────

export interface GetWebhookRequest {
  readonly webhook_id: string;
}

export type GetWebhookResponse = WebhookSubscription;

export interface UpdateWebhookRequest {
  readonly webhook_id: string;
  // At least one of `events` / `callback_url` must be present. The secret
  // is immutable and the owning agent cannot be reassigned.
  readonly events?: readonly WebhookEvent[];
  readonly callback_url?: string;
}

export type UpdateWebhookResponse = WebhookSubscription;

// Payload shape every subscriber receives. `data` is event-specific and
// typed by the subscriber per the union below.
export interface WebhookDeliveryEnvelope<T = unknown> {
  readonly event: WebhookEvent;
  readonly emitted_at: string; // ISO 8601
  readonly trace_id: string | null;
  readonly data: T;
}

// Header name constants for the signature + delivery metadata. The
// `x-facet-signature` header is shared between synchronous responses
// and webhook deliveries; the two carry different fields
// inside the comma-separated value (responses: t+kid+v1, webhooks:
// t+v1+kid+v2). Parsing lives in @facet/response-verifier.
export const HEADER_FACET_SIGNATURE = "x-facet-signature";
export const HEADER_WEBHOOK_SIGNATURE = HEADER_FACET_SIGNATURE;
export const HEADER_WEBHOOK_EVENT = "x-facet-event";
export const HEADER_WEBHOOK_DELIVERY_ID = "x-facet-delivery-id";

// ─────────────────────────────────────────────────────────────────────────────
// Agent Reputation Registry public API
//
// One call, one agent, cross-site aggregate. Anyone — agent operators
// checking their own reputation, publishers evaluating an inbound
// agent, third-party scorers — can call `POST /v1/reputation` with a
// known aid and get the aggregate counters + derived tier/score. The
// route is a public read endpoint, rate-limited at a lower tier so it
// can't be used as a scraping index.
// ─────────────────────────────────────────────────────────────────────────────

export type ReputationTier = "poor" | "normal" | "good" | "trusted" | "unknown";

export interface ReputationRequest {
  readonly aid: string;
}

export interface ReputationResponse {
  readonly aid: string;
  // Aggregated counters. Zero across the board for an unknown aid —
  // the response shape doesn't signal "unknown agent" via a 404; it
  // returns the zero counters + `tier: "unknown"` so scorers can
  // treat missing and zero identically.
  readonly counters: {
    readonly successes: number;
    readonly rate_limited_count: number;
    readonly error_count: number;
    readonly signed_receipts_count: number;
    readonly chargebacks_count: number;
  };
  // Number of distinct Facet sites this agent has any counter row on.
  // 0 for unknown agents; 1+ for any agent with recorded activity.
  readonly total_sites: number;
  // Derived — matches the Terminal's scoring logic. Clients should
  // prefer this to re-implementing the math.
  readonly score: number;
  readonly tier: ReputationTier;
  readonly first_seen_at: string | null; // ISO 8601
  readonly last_seen_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// /.well-known/facet-keys.json
//
// Site publishes its Ed25519 response-signing
// keys. `keys` contains every row with status ∈ ('current','previous')
// so verifiers in the middle of a rotation keep working. `current_kid`
// names the one the signer is actively using for new responses.
// ─────────────────────────────────────────────────────────────────────────────

export interface FacetPublicKey {
  readonly kid: string;
  readonly alg: "Ed25519";
  readonly public_key_b64: string; // raw 32-byte public key, base64url
}

export interface FacetKeyBundle {
  readonly keys: readonly FacetPublicKey[];
  readonly current_kid: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// request_human(reason, context)
//
// Escape hatch for anything the deterministic
// tool surface can't express (bulk quotes, compliance edge cases,
// custom contracts). Agents file the ticket + SLA; a site operator
// closes it out of band. A future revision adds a read-side console —
// this chunk is write-only.
// ─────────────────────────────────────────────────────────────────────────────

export type EscalationStatus = "open" | "acknowledged" | "in_progress" | "resolved" | "closed";

export interface EscalationTicket {
  readonly ticket_id: string;
  readonly status: EscalationStatus;
  readonly reason: string;
  readonly sla_hours: number;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface RequestHumanRequest {
  readonly reason: string;
  readonly context?: Record<string, unknown>;
}

export type RequestHumanResponse = EscalationTicket;

// ─────────────────────────────────────────────────────────────────────────────
// identify / session_extend / whoami
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentifyResponse {
  readonly session_id: string;
  readonly aid: string;
  readonly apd: string | null;
  readonly scopes: readonly string[];
  readonly expires_at: string;
}

export interface SessionExtendRequest {
  readonly session_id: string;
}

/** Response shape returned by POST /v1/session_extend. The Terminal
 *  reuses the IdentifyResponse shape — keeping a dedicated alias here
 *  gives the OpenAPI spec a stable per-route name. */
export type SessionExtendResponse = IdentifyResponse;

export interface WhoamiResponse {
  readonly aid: string;
  readonly apd: string | null;
}

// ── Phase 2 tier-A2 — session CRUD over the caller's own sessions ──────────

/** One of the caller's open sessions. Mirrors the IdentifyResponse fields
 *  minus the agent identity (which the caller already knows), plus the
 *  creation timestamp so a client can sort newest-first. */
export interface SessionSummary {
  readonly session_id: string;
  readonly scopes: readonly string[];
  readonly created_at: string; // ISO 8601
  readonly expires_at: string; // ISO 8601
}

export interface ListSessionsResponse {
  readonly sessions: readonly SessionSummary[];
}

export interface RevokeSessionRequest {
  readonly session_id: string;
}

export interface RevokeSessionResponse {
  readonly session_id: string;
  readonly revoked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supplementary route types.
//
// Each block below mirrors the wire shape of one Terminal route
// not already covered earlier in this file or in the per-primitive
// type modules (booking-types, subscription-types, etc.).
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /v1/hello ───────────────────────────────────────────────────────────

export interface HelloResponse {
  readonly hello: string;
  readonly verified_at: string;
}

// ── GET /.well-known/microsoft-identity-association.json ────────────────────
//
// Vendor-frozen shape — frozen by Microsoft Entra's publisher-domain
// verification model. Documented here so the OpenAPI spec can declare
// the response surface without inlining the shape per route.

export interface MsIdentityAssociatedApplication {
  readonly applicationId: string;
}

export interface MsIdentityAssociationResponse {
  readonly associatedApplications: readonly MsIdentityAssociatedApplication[];
}

// ── POST /v1/oms/push_order ─────────────────────────────────────────────────

export interface OmsPushOrderRequest {
  readonly order_id: string;
}

export interface OmsPushOrderResponse {
  /** OMS adapter identifier (e.g., "shopify"). */
  readonly provider: string;
  /** Provider-side order id created by the push. */
  readonly external_id: string;
  /** True when the order had already been pushed and the Terminal
   *  short-circuited with the stored external_id (idempotent replay). */
  readonly already_pushed: boolean;
}

// ── POST /v1/oms/push_refund ────────────────────────────────────────────────

export interface OmsPushRefundRequest {
  readonly refund_id: string;
}

export interface OmsPushRefundResponse {
  /** OMS adapter identifier (e.g., "shopify"). */
  readonly provider: string;
  /** Provider-side refund id created by the mirror. */
  readonly external_id: string;
  /** True when the refund had already been mirrored and the Terminal
   *  short-circuited with the stored external_id (idempotent replay). */
  readonly already_pushed: boolean;
}

// ── POST /v1/quote_license ──────────────────────────────────────────────────
//
// Returned by the Terminal's license-quote route. The `offer` object
// MAY carry additional fields as the route evolves — callers should
// treat unknown fields as forward-compatible additions.

export interface LicenseOffer {
  readonly site_id: string;
  readonly scope: string;
  readonly price_minor: number;
  readonly currency: string;
  readonly ttl_seconds: number;
  readonly usage_limit: number | null;
  readonly usage_limit_kind: string | null;
  readonly rail: string;
  /** Forward-compatible escape valve for fields the server adds before
   *  the protocol catches up. */
  readonly [key: string]: unknown;
}

export interface QuoteLicenseRequest {
  readonly site_id: string;
  readonly scope: string;
}

export interface QuoteLicenseResponse {
  readonly offer: LicenseOffer;
}

// ── POST /v1/submit_proof_attestation ───────────────────────────────────────

/** Catalog of attestation kinds the Terminal accepts. Mirrors the
 *  proof kinds the Terminal enforces at runtime. */
export type ProofKind =
  "age" | "jurisdiction" | "license" | "kyc" | "prescription" | "license_export";

export const PROOF_KINDS: readonly ProofKind[] = [
  "age",
  "jurisdiction",
  "license",
  "kyc",
  "prescription",
  "license_export",
] as const;

export interface SubmitProofAttestationRequest {
  readonly proof_kind: ProofKind;
  readonly issuer: string;
  /** Compact JWS — 3 base64url segments separated by `.`. */
  readonly jws: string;
  /** ISO 8601. When omitted the attestation has no Facet-tracked
   *  expiry; verifiers should still observe `exp` in the JWS payload. */
  readonly expires_at?: string;
}

export interface SubmitProofAttestationResponse {
  readonly attestation_id: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly proof_kind: ProofKind;
}

// ── POST /v1/webhooks/calendly ──────────────────────────────────────────────
//
// Vendor-relay route — the inbound shape is owned by Calendly. The ack
// response is Facet-owned. The rate-limited branch returns a
// `{ error, message }` shape distinct from the standard error envelope.

export interface CalendlyWebhookAckIgnored {
  readonly ok: true;
  readonly event: string;
  readonly action: "ignored";
}

export interface CalendlyWebhookAckNoMatch {
  readonly ok: true;
  readonly action: "no_match";
  readonly scheduling_link_uri: string;
}

export interface CalendlyWebhookAckConfirmed {
  readonly ok: true;
  readonly action: "confirmed";
  readonly booking_id: string;
}

/** Rate-limited response for the Calendly webhook route. This branch
 *  returns a `{ error, message }` shape distinct from
 *  `FacetErrorEnvelope`; callers handling this route should accept both
 *  shapes. */
export interface CalendlyWebhookRateLimited {
  readonly error: "rate_limited";
  readonly message: string;
}

export type CalendlyWebhookResponse =
  | CalendlyWebhookAckIgnored
  | CalendlyWebhookAckNoMatch
  | CalendlyWebhookAckConfirmed
  // distinct `{ error, message }` shape, not the standard envelope
  | CalendlyWebhookRateLimited;

// ─────────────────────────────────────────────────────────────────────────────
// Shared header conventions
// ─────────────────────────────────────────────────────────────────────────────

export const HEADER_TRACE_ID = "x-agent-trace-id";
export const HEADER_RATE_LIMIT_LIMIT = "x-facet-ratelimit-limit";
export const HEADER_RATE_LIMIT_REMAINING = "x-facet-ratelimit-remaining";
export const HEADER_RATE_LIMIT_RESET = "x-facet-ratelimit-reset";
export const HEADER_IDEMPOTENCY_KEY = "idempotency-key";
export const HEADER_RETRY_AFTER = "retry-after";

// ─────────────────────────────────────────────────────────────────────────────
// get_settlement / list_settlements — POST /v1/get_settlement, /v1/list_settlements
//
// Operator-scoped reads over the per-site settlements journal (one row per
// money-op dispatch trace_id). Both carry `site_id` in the body and are
// gated by requireSiteRole(req, cfg, site_id, "viewer") — a settlement of
// another site reads back as NOT_FOUND on get and never appears in list.
// The wire `Settlement` mirrors the journal row; `amount_atomic` is a
// string so large 6-decimal USDC values never lose precision.
// ─────────────────────────────────────────────────────────────────────────────

export type SettlementState = "pending" | "confirmed" | "failed";

export interface Settlement {
  // The dispatch trace_id (the journal's primary key).
  readonly settlement_id: string;
  readonly site_id: string;
  readonly merchant_id: string | null;
  readonly rail_id: string;
  readonly op: string;
  readonly state: SettlementState;
  readonly exchange_id: string | null;
  readonly tx_hash: string | null;
  readonly agent_aid: string | null;
  // Amount in the rail's smallest unit, stringified (USDC = 6 decimals).
  readonly amount_atomic: string | null;
  readonly currency: string | null;
  readonly error_code: string | null;
  readonly created_at: string; // ISO 8601
  readonly updated_at: string; // ISO 8601
}

export interface GetSettlementRequest {
  readonly site_id: string;
  readonly settlement_id: string;
}

export type GetSettlementResponse = Settlement;

export interface ListSettlementsRequest {
  readonly site_id: string;
  // Optional lifecycle filter; omit for all states.
  readonly state?: SettlementState;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListSettlementsResponse {
  readonly settlements: readonly Settlement[];
  readonly next_cursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/settlements/reconcile — operator-scoped settlement RECONCILER.
//
// Closes the webhook-as-single-point-of-failure: a lost or delayed Boson
// settlement webhook would otherwise strand a Boson exchange in a non-terminal
// status (committed/redeemed) even after the escrow has actually RELEASED
// on-chain. This proactively re-reads stuck exchanges on-chain and advances any
// that the chain shows have reached the terminal/RELEASED (COMPLETED) state —
// doing exactly what the webhook does, but pulled proactively instead of waiting
// for a webhook delivery. Gated by requireSiteRole(req, cfg, site_id, "admin").
//
// IDEMPOTENT: an already-terminal row is never scanned; a not-yet-released
// exchange is left untouched (never mis-advanced); re-running never
// double-advances. Site-scoped — a reconcile of site A never touches site B's
// rows.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileSettlementsRequest {
  // UUID. The caller must be an admin+ member of this site. Only this site's
  // stuck Boson exchanges are scanned.
  readonly site_id: string;
  // Grace window in seconds: only exchanges last updated at least this long ago
  // are scanned, so freshly-committed rows the webhook may still settle are not
  // pre-empted. Optional; the server applies a default + bounds.
  readonly grace_seconds?: number;
  // Max number of stuck exchanges to scan in one call. Optional; bounded server-side.
  readonly limit?: number;
}

// Per-exchange outcome of one reconcile pass; surfaced so an operator can see
// exactly which exchanges advanced and why a pending one did not.
export type ReconcileSettlementOutcome = "advanced" | "skipped" | "still_pending";

export interface ReconcileSettlementResult {
  readonly exchange_id: string;
  readonly outcome: ReconcileSettlementOutcome;
  // Human-readable reason (on-chain state, skip reason, or read error).
  readonly reason: string;
}

export interface ReconcileSettlementsResponse {
  // Total stuck exchanges examined this pass.
  readonly scanned: number;
  // Re-read RELEASED on-chain and advanced to settled.
  readonly advanced: number;
  // Already terminal / not actionable — skipped without a chain read advancing them.
  readonly skipped: number;
  // Re-read but not yet RELEASED on-chain — left untouched for a later pass.
  readonly still_pending: number;
  readonly results: readonly ReconcileSettlementResult[];
}

// ── GET /v1/promo/slots ─────────────────────────────────────────────────────

export interface PromoSlotsResponse {
  /** Sites claimed under Tier 1 (any platform, free Pro + 0% Facet fee, 12 months). */
  readonly tier1_claimed: number;
  /** Tier 1 cap. */
  readonly tier1_cap: number;
  /** Sites claimed under Tier 2 (WooCommerce, 0% Facet fee, 12 months). */
  readonly tier2_claimed: number;
  /** Tier 2 cap. */
  readonly tier2_cap: number;
  /** False when the counts are placeholder zeros (no database configured). */
  readonly live: boolean;
}
