// @facet-llc/protocol — Payment-rail adapter interface.
//
// A FacetPaymentRailAdapter is the SETTLEMENT side of an agent payment:
// once an inbound request has been authenticated (by an OriginationVerifier
// for agent identity, plus the Terminal's own merchant-side auth), the
// adapter takes the payment-authority artifact (x402 X-PAYMENT payload,
// Stripe payment_intent_id, Boson exchange token, …) and walks it through
// verify -> reserve -> capture -> {refund,dispute} -> webhook events.
//
// Adapters are the SOLE mechanism by which the Terminal moves money. The
// Terminal handler is rail-agnostic; it picks the right adapter based on
// the request's settlement_rail header (matching `id` below) and delegates.
//
// Adapters MUST be:
//   - Stateless. All persistence flows through the Terminal's managed
//     storage, never the adapter's own DB. This is the zero-data-plane
//     invariant.
//   - Idempotent on `idempotency_key`. The Terminal retries on transient
//     errors; the adapter must collapse retries to the same downstream
//     effect.
//   - Side-effect-free outside the rail call. No telemetry beyond return
//     values, no log writes (the Terminal logs the Result), no metric
//     emission (the Terminal owns observability).
//   - Network-bounded. Each adapter package declares its outbound
//     destinations in `egress_allowlist` so the runtime sandbox can enforce
//     least-privilege network policy.
//
// Adapters MUST NOT:
//   - Read or write merchant tenant data directly. The Terminal hands them
//     the opaque `merchant_config` they need; nothing else.
//   - Hold credentials inline. All secrets arrive via `merchant_config`,
//     which the Terminal hydrates from its managed secret store per
//     merchant.
//   - Throw for known failure modes. Use `RailAdapterResult` with a typed
//     error code. Throw only for programmer errors (unreachable, etc.).

import type { FacetErrorCode } from "./terminal-types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** Stable rail identifier — namespaces match the `settlement_rails` field
 *  on `/v1/terms` (see terminal-types.ts). Examples:
 *    - "coin/usdc-base"           — x402 USDC on Base, Coinbase facilitator
 *    - "coin/usdc-base-sepolia"   — x402 on Base testnet
 *    - "coin/boson-escrow"        — rNFT escrow via Boson Protocol
 *    - "card/stripe"              — Stripe Cards / ACH / wallets
 *    - "card/visa-vic"            — Visa Intelligent Commerce
 *    - "card/mastercard-scof"     — Mastercard SCOF (Agent Pay)
 *    - "voucher/<issuer-id>"          — prepaid voucher from a KYA issuer
 */
export type RailId = string;

/** Adapter self-description surfaced on `/v1/capabilities` and used by the
 *  Terminal dispatcher to decide which adapter receives a given request. */
export interface RailAdapterMetadata {
  readonly id: RailId;
  readonly display_name: string;
  /** Semver of the adapter package itself. Tracked separately from the
   *  protocol version so a single Terminal can run mixed-version adapters
   *  side-by-side during rolling upgrades. */
  readonly version: string;
  /** False for instant-settle rails where reserve is a no-op (x402). True
   *  for two-step rails where reserve produces a holdable authorization
   *  that can later be captured or voided (Stripe, AgentCore session). */
  readonly supports_reserve_capture: boolean;
  /** True iff the rail exposes a refund mechanism the merchant can trigger
   *  programmatically. */
  readonly supports_refund: boolean;
  /** True iff the rail surfaces dispute / chargeback events to the merchant
   *  (typically false for on-chain rails, true for card rails). */
  readonly supports_dispute: boolean;
  /** For crypto rails: network identifiers the adapter can settle on
   *  (e.g., ["base-mainnet", "base-sepolia"]). For card rails: card
   *  scheme identifiers (e.g., ["visa", "mastercard", "amex"]). For
   *  voucher rails: the voucher issuer namespace. */
  readonly networks: readonly string[];
  /** ISO 4217 currency codes the adapter accepts (e.g., ["USD", "EUR"]).
   *  Crypto rails advertise the on-chain asset symbol where there is no
   *  ISO code (e.g., ["USDC", "EURC"]). */
  readonly currencies: readonly string[];
  /** Outbound destinations the adapter needs at runtime. Used by the
   *  sandbox runtime to enforce per-binary network policy. */
  readonly egress_allowlist: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Result envelope
// ─────────────────────────────────────────────────────────────────────────────

/** Adapters return this discriminated union; the Terminal pattern-matches
 *  the `kind` to decide whether to retry, surface an error, or proceed. */
export type RailAdapterResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "rate_limited";
      readonly retry_after_seconds: number;
    }
  | {
      readonly kind: "error";
      /** Code MUST be one of FacetErrorCode so the Terminal can map it
       *  into the public error envelope without translation. */
      readonly code: FacetErrorCode;
      readonly message: string;
      /** True iff the Terminal should retry after backoff. */
      readonly retryable: boolean;
      /** Rail-native error code for forensics — surfaced only in audit
       *  logs, never to the agent. */
      readonly native_code?: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Merchant + order context
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque rail-specific merchant config — hydrated by the Terminal from
 *  its managed storage and secret store per merchant + rail pair. The
 *  adapter treats this as a black box read; the Terminal owns the
 *  schema. */
export type MerchantConfig = Readonly<Record<string, unknown>>;

/** Per-call request context. `trace_id` and `idempotency_key` flow from
 *  the agent's request headers. `merchant_id` and `site_id` are the
 *  Terminal's tenant scope. */
export interface RailRequestContext {
  readonly trace_id: string;
  readonly idempotency_key: string;
  readonly merchant_id: string;
  readonly site_id: string;
  /** UTC ISO-8601 — the moment the Terminal received the request. */
  readonly received_at: string;
}

/** Money in the rail's native granularity. Adapters MUST validate that
 *  the currency matches one of `RailAdapterMetadata.currencies`. */
export interface MoneyAmount {
  /** Integer in the rail's smallest unit:
   *    - For ISO currencies: cents (e.g., 1234 for $12.34 USD).
   *    - For on-chain stablecoins: the asset's atomic unit (e.g., USDC
   *      uses 6 decimals on Base, so 1230000 = 1.23 USDC). */
  readonly amount: number;
  /** ISO 4217 code OR on-chain asset symbol (e.g., "USD", "USDC"). */
  readonly currency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// verify_authority — does this payment-authority artifact actually authorize
// the amount the agent is asking us to charge?
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyAuthorityInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  /** The rail-specific authority artifact:
   *    - x402: the decoded `X-PAYMENT` payload (EIP-3009 signature etc.)
   *    - Stripe: the payment_method_id or setup_intent_id
   *    - AgentCore session: the session_id + nonce
   *    - Boson: the exchange voucher
   *    - Voucher issuer: the voucher token
   *  Adapters parse and validate per their rail's spec. */
  readonly authority: Readonly<Record<string, unknown>>;
  /** The amount the agent is asking us to authorize for capture. */
  readonly amount: MoneyAmount;
}

export interface VerifyAuthorityOk {
  /** Adapter-issued opaque handle the Terminal will pass to
   *  reserve_authority / capture / refund. The Terminal stores it on the
   *  order row; the adapter is responsible for re-resolving it on
   *  subsequent calls (typically a rail-side payment_intent_id, escrow
   *  contract address, etc.). */
  readonly authority_handle: string;
  /** UTC ISO-8601 — when this authority stops being valid. Terminal
   *  uses this to set the quote expiry. Null for rails with no expiry. */
  readonly expires_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// reserve_authority — for two-step rails, place a hold. For instant-settle
// rails, this is a no-op that just echoes back the handle.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReserveAuthorityInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  readonly authority_handle: string;
  readonly amount: MoneyAmount;
}

export interface ReserveAuthorityOk {
  /** True iff funds are now actively held against the authority.
   *  Adapters where the rail has no separate reserve step (x402)
   *  set this to false and return immediately. */
  readonly reservation_active: boolean;
  /** UTC ISO-8601 — when the hold expires if not captured. Null for
   *  no-op reserves. */
  readonly reserved_until: string | null;
  /** Optional rail-specific metadata the Terminal threads verbatim into
   *  the signed receipt envelope + dispatch log. For Boson's escrow rail
   *  this carries the post-commit `escrow_state` (`{exchange_id,
   *  exchange_state, dispute_state}`) + the commit tx hash so the agent
   *  learns the exchange id it must redeem against. Opaque to the
   *  Terminal — copied, never interpreted. */
  readonly rail_metadata?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// capture — settle the funds. After this returns ok, the merchant has the
// money (modulo on-chain confirmation depth, which the adapter manages).
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  readonly authority_handle: string;
  readonly amount: MoneyAmount;
  /** Optional rail-specific artifact supplied at capture time, for rails
   *  whose settlement step needs a fresh authorization that could not be
   *  produced at verify time. Most rails ignore this (instant-settle x402
   *  and Stripe re-present the handle alone). Boson's two-step escrow
   *  needs the buyer's `boson-redeem` meta-tx here, since redeem can only
   *  be signed AFTER reserve (commit) assigns the exchange id. Same opaque
   *  shape as `VerifyAuthorityInput.authority`. */
  readonly authority?: Readonly<Record<string, unknown>>;
}

export interface CaptureOk {
  /** Rail-native settlement identifier — on-chain tx hash, Stripe
   *  charge_id, etc. Persisted to the order row for forensics + refund. */
  readonly settlement_id: string;
  /** UTC ISO-8601 — when the rail confirmed settlement. */
  readonly settled_at: string;
  /** Optional rail-specific metadata the Terminal threads verbatim into
   *  the signed receipt envelope + dispatch log. Escrow rails surface the
   *  on-chain escrow state here (e.g. Boson's `escrow_state` =
   *  `{exchange_id, exchange_state, dispute_state}` + the settlement tx
   *  hash). Opaque to the Terminal — copied, never interpreted. */
  readonly rail_metadata?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// refund — partial or full. Idempotent on idempotency_key.
// ─────────────────────────────────────────────────────────────────────────────

export interface RefundInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  readonly settlement_id: string;
  readonly amount: MoneyAmount;
  readonly reason: string;
}

export interface RefundOk {
  readonly refund_id: string;
  readonly refunded_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// dispute — only for rails where `supports_dispute` is true. Card rails
// receive these as inbound webhooks (the rail tells US a dispute opened);
// adapters expose this method so the Terminal can act on a dispute
// programmatically (counter-evidence upload, accept, etc.).
// ─────────────────────────────────────────────────────────────────────────────

export interface DisputeInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  readonly settlement_id: string;
  readonly action: "accept" | "challenge";
  /** Rail-specific evidence payload (URLs, line-item proofs, shipping
   *  data). Opaque to the Terminal. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface DisputeOk {
  readonly dispute_id: string;
  readonly status: "open" | "won" | "lost" | "withdrawn";
}

// ─────────────────────────────────────────────────────────────────────────────
// handle_webhook — adapter-specific inbound event from the rail
// (settlement confirmation, dispute opened, refund completed, …).
// The Terminal verifies the signature using the adapter's `verify_webhook`
// helper, then delegates the event body to handle_webhook.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookRequest {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  /** Raw bytes of the webhook body — needed for signature verification
   *  in some rails (Stripe). */
  readonly raw_body: Uint8Array;
  /** Parsed body, if the adapter trusts the format. The Terminal parses
   *  JSON before delegating; adapters that need different parsing
   *  (form-encoded, protobuf) should set this to null and parse
   *  raw_body themselves. */
  readonly parsed_body: Readonly<Record<string, unknown>> | null;
  readonly headers: Readonly<Record<string, string>>;
}

/** Discriminated union of normalized webhook outcomes. The Terminal maps
 *  these to side-effects (order row updates, refund row inserts, …). */
export type WebhookOutcome =
  | {
      readonly kind: "settlement_confirmed";
      readonly settlement_id: string;
      readonly confirmed_at: string;
    }
  | {
      readonly kind: "refund_completed";
      readonly refund_id: string;
      readonly settlement_id: string;
      readonly refunded_at: string;
    }
  | {
      readonly kind: "dispute_opened";
      readonly dispute_id: string;
      readonly settlement_id: string;
      readonly opened_at: string;
      readonly amount: MoneyAmount;
      readonly reason_code: string;
    }
  | {
      readonly kind: "dispute_resolved";
      readonly dispute_id: string;
      readonly resolution: "won" | "lost" | "withdrawn";
      readonly resolved_at: string;
    }
  | {
      readonly kind: "ignored";
      readonly reason: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// build_requirements — produce the rail's payment-requirements (the 402
// "accepts" entry) for an amount, BEFORE the agent holds any authority. Only
// rails that gate settlement on a server-/merchant-signed offer need this:
// Boson escrow signs a FullOffer the agent then commits against, and
// `verifyAuthority` REJECTS any offer not signed by the merchant's seller
// signer — so the agent cannot self-produce a valid one. Instant-authority
// rails (x402, Stripe) let the agent present an authority the rail settles
// without a server-produced requirements artifact, so they leave this
// unimplemented and the dispatcher returns METHOD_NOT_ALLOWED.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildRequirementsInput {
  readonly ctx: RailRequestContext;
  readonly merchant_config: MerchantConfig;
  /** The amount to be charged, in the rail's atomic units. */
  readonly amount: MoneyAmount;
  /** Rail-specific quote options (offer / dispute / redeem windows, quantity,
   *  token-auth strategies, …). Opaque to the Terminal; the adapter applies
   *  sane defaults for anything omitted. */
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface BuildRequirementsOk {
  /** The rail-specific payment-requirements body the agent echoes back at
   *  verify time. For Boson escrow this is the seller-signed
   *  `EscrowPaymentRequirements` (the 402 "accepts" entry). Opaque to the
   *  Terminal — returned to the agent verbatim. */
  readonly requirements: Readonly<Record<string, unknown>>;
  /** UTC ISO-8601 — when this quote stops being committable (offer-validity /
   *  maxTimeoutSeconds horizon). Null if the rail has no expiry. */
  readonly expires_at: string | null;
  /** Optional rail metadata threaded into the dispatch log + response (e.g.
   *  the Boson exchange windows actually applied). Opaque — copied, never
   *  interpreted. */
  readonly rail_metadata?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The adapter interface itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface FacetPaymentRailAdapter {
  readonly metadata: RailAdapterMetadata;

  /** Validate the inbound authority artifact and translate it into an
   *  opaque handle the Terminal can re-present for capture. */
  verifyAuthority(input: VerifyAuthorityInput): Promise<RailAdapterResult<VerifyAuthorityOk>>;

  /** Place a hold (two-step rails) or no-op (instant-settle rails). */
  reserveAuthority(input: ReserveAuthorityInput): Promise<RailAdapterResult<ReserveAuthorityOk>>;

  /** Settle the funds. */
  capture(input: CaptureInput): Promise<RailAdapterResult<CaptureOk>>;

  /** Reverse a prior settlement, partially or fully. Only callable if
   *  `metadata.supports_refund` is true. */
  refund(input: RefundInput): Promise<RailAdapterResult<RefundOk>>;

  /** Act on a dispute. Only callable if `metadata.supports_dispute` is
   *  true. */
  dispute?(input: DisputeInput): Promise<RailAdapterResult<DisputeOk>>;

  /** Produce the rail's payment-requirements (402 "accepts" entry) for an
   *  amount — for rails that gate settlement on a server-signed offer (Boson
   *  escrow). Optional: instant-authority rails leave it unimplemented and the
   *  dispatcher returns METHOD_NOT_ALLOWED. (Named `quoteRequirements` to avoid
   *  colliding with rails that already expose an unrelated concrete
   *  `buildRequirements` helper, e.g. the x402-coinbase adapter.) */
  quoteRequirements?(
    input: BuildRequirementsInput,
  ): Promise<RailAdapterResult<BuildRequirementsOk>>;

  /** Verify and parse an inbound webhook. */
  handleWebhook(input: WebhookRequest): Promise<RailAdapterResult<WebhookOutcome>>;
}
