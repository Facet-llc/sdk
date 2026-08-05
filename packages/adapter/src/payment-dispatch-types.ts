// @facet-llc/adapter — Multi-rail payment dispatch wire-contract types.
//
// Canonical `PaymentsDispatchRequest` wire-contract types, authored in
// the protocol package.
//
// SECURITY NOTE: the request type does NOT carry `merchant_config`. The
// Terminal explicitly discards any caller-supplied merchant_config and
// rebuilds it server-side from the authenticated site row — callers
// cannot influence merchant configuration through this contract.
//
// Three Terminal routes share the types in this module:
//   POST /v1/payments/dispatch
//   GET  /v1/payments/capabilities
//   POST /v1/payments/route

import type { MoneyAmount, RailId } from "./rail-adapter.ts";

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/payments/dispatch — request
//
// Wire contract: `op` is the discriminant; required fields per variant
// are checked by the handler before adapter dispatch. The handler
// short-circuits `handle_webhook` with METHOD_NOT_ALLOWED today; the
// op is kept in the union for backwards-compatibility with SDKs that
// already enumerate it. Removing it from the wire surface is a
// breaking change deferred to a major version bump.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentsDispatchOp =
  "verify_authority" | "reserve_authority" | "capture" | "refund" | "dispute" | "handle_webhook";

/** Common fields every dispatch request carries regardless of `op`. */
export interface PaymentsDispatchRequestBase {
  /** Owning site — bound by Terminal-side authorization. */
  readonly site_id: string;
  /** Rail-specific override; when omitted the Terminal sniffs from
   *  headers (X-Facet-Rail / X-PAYMENT) or authority shape. */
  readonly rail_id?: RailId;
  /** Optional idempotency key. Falls back to the `idempotency-key`
   *  header, then to a freshly minted UUID. */
  readonly idempotency_key?: string;
  /** Optional merchant identifier override. Defaults to `site_id`. */
  readonly merchant_id?: string;
}

export interface VerifyAuthorityDispatch extends PaymentsDispatchRequestBase {
  readonly op: "verify_authority";
  readonly amount: MoneyAmount;
  readonly authority: Readonly<Record<string, unknown>>;
}

export interface ReserveAuthorityDispatch extends PaymentsDispatchRequestBase {
  readonly op: "reserve_authority";
  readonly amount: MoneyAmount;
  readonly authority_handle: string;
}

export interface CaptureDispatch extends PaymentsDispatchRequestBase {
  readonly op: "capture";
  readonly amount: MoneyAmount;
  readonly authority_handle: string;
}

export interface RefundDispatch extends PaymentsDispatchRequestBase {
  readonly op: "refund";
  readonly amount: MoneyAmount;
  readonly settlement_id: string;
  readonly reason: string;
  /** Optional 0x address the refund pays back to. Required by the x402 rail
   *  (a merchant-signed ERC-3009 transfer to this address); ignored by rails
   *  that reverse off the settlement handle alone (Stripe) or the buyer voucher
   *  (Boson). The Terminal threads it into the adapter's RefundInput. */
  readonly refund_to?: string;
}

export interface DisputeDispatch extends PaymentsDispatchRequestBase {
  readonly op: "dispute";
  readonly settlement_id: string;
  readonly dispute_action: "accept" | "challenge";
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** Reachable in the union for SDK back-compat but the Terminal returns
 *  METHOD_NOT_ALLOWED for this op today — webhook ingress flows
 *  through rail-native routes (e.g. POST /v1/stripe/webhook). */
export interface HandleWebhookDispatch extends PaymentsDispatchRequestBase {
  readonly op: "handle_webhook";
}

export type PaymentsDispatchRequest =
  | VerifyAuthorityDispatch
  | ReserveAuthorityDispatch
  | CaptureDispatch
  | RefundDispatch
  | DisputeDispatch
  | HandleWebhookDispatch;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/payments/dispatch — response
// ─────────────────────────────────────────────────────────────────────────────

/** Per-dispatch summary of the authenticated agent principal. */
export interface DispatchAgentSummary {
  readonly aid: string;
  readonly issuer: string;
  readonly acting_for: string | null;
}

export interface PaymentsDispatchResponse {
  readonly rail_id: RailId;
  /** Verifier id that authenticated the agent's origination
   *  attestation (e.g., "issuer/direct", "anthropic/cdp"). */
  readonly origination_id: string;
  readonly agent: DispatchAgentSummary;
  /** The adapter's raw result — typed `unknown` because the inner
   *  shape varies per op (see VerifyAuthorityOk, ReserveAuthorityOk,
   *  CaptureOk, RefundOk, DisputeOk in rail-adapter.ts). */
  readonly result: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/payments/capabilities
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentsCapabilitiesResponse {
  /** Registered rails on this Terminal. Empty when the dispatcher
   *  is not configured. */
  readonly rails: readonly RailId[];
  /** Coarse-grained verifier kinds (jwt / voucher / hmac / direct).
   *  Vendor-specific identifiers are intentionally not exposed here. */
  readonly verifier_kinds: readonly string[];
  /** False when the dispatcher hasn't been wired (env-gated). */
  readonly configured: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/payments/route — read-only introspection
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentsRouteRequest {
  /** Optional authority artifact — same shape the adapter would see
   *  on `verify_authority`. Used purely for rail sniffing. */
  readonly authority?: Readonly<Record<string, unknown>>;
}

export interface PaymentsRouteResponse {
  readonly rail_id: RailId | null;
  readonly origination_id: string;
  readonly dispatcher_configured: boolean;
}
