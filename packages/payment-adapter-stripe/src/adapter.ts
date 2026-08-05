// StripeAdapter — FacetPaymentRailAdapter for the Stripe rail (cards,
// ACH, wallets via PaymentIntents).
//
// Delegates verification, capture, refund, dispute, and webhook
// signature validation to the official `stripe` npm SDK. We do NOT
// reimplement HMAC-SHA256 over `stripe-signature`, the PI state
// machine, or the form-encoded API client — Stripe's library is the
// authoritative source for all of those.
//
// Lifecycle mapping to FacetPaymentRailAdapter:
//   verifyAuthority   — creates a manual-capture PaymentIntent (status
//                       requires_capture once confirmed) and returns the
//                       PI id as the authority handle.
//   reserveAuthority  — no-op echo (PI creation already places the hold).
//   capture           — paymentIntents.capture(id) → charge settled.
//   refund            — refunds.create({ payment_intent }).
//   dispute           — disputes.update / disputes.close.
//   handleWebhook     — webhooks.constructEvent → normalized
//                       WebhookOutcome.
//
// Connect: when `connect_account_id` is supplied in merchant_config, the
// adapter uses Stripe DIRECT CHARGES — the `stripeAccount` request
// option creates the PaymentIntent on the merchant's connected account,
// so the money lands there directly. `application_fee_minor` optionally
// instructs Stripe to atomically transfer a platform fee to Facet's
// platform account; the customer's money never sits in Facet's account.
//
// This non-custodial posture is a locked architectural invariant.
// Facet's platform account only processes Facet SaaS subscription
// billing (Pro/Enterprise), never merchant payments. Do NOT add
// `transfer_data.destination` — that would switch this to destination
// charges and break the invariant.

import type {
  CaptureInput,
  CaptureOk,
  DisputeInput,
  DisputeOk,
  FacetPaymentRailAdapter,
  MerchantConfig,
  RailAdapterMetadata,
  RailAdapterResult,
  RefundInput,
  RefundOk,
  ReserveAuthorityInput,
  ReserveAuthorityOk,
  VerifyAuthorityInput,
  VerifyAuthorityOk,
  WebhookOutcome,
  WebhookRequest,
} from "@facet-llc/adapter";
import { Buffer } from "node:buffer";
import Stripe from "stripe";

const PACKAGE_VERSION = "0.2.0";
// Pinned to the wire API version stripe@22 ships (its `ApiVersion` const). Keep
// this in lockstep with the `stripe` dependency on every SDK major bump — the
// usage site (new Stripe({ apiVersion })) is what type-checks it against the SDK.
const STRIPE_API_VERSION = "2026-05-27.dahlia";

/** Facet-side identity record for one Stripe PaymentIntent. The
 *  adapter writes one of these on the PI-create path inside
 *  `verifyAuthority` and reads it on every subsequent reserveAuthority
 *  / capture / refund call to confirm the caller is the same Facet
 *  flow that originated the PI. */
export interface PaymentIntentRecord {
  readonly stripe_payment_intent_id: string;
  readonly site_id: string;
  readonly expected_amount_minor: number;
  readonly expected_currency: string;
  readonly facet_trace_id: string;
}

/** Pluggable store for the PaymentIntent-tracking table. Production
 *  wiring uses a database-backed implementation; tests inject an
 *  in-memory map so the adapter's cross-check logic is unit-testable
 *  without a database. */
export interface PaymentIntentStore {
  /** Write a new record. Implementations should treat duplicate PI ids
   *  as an UPSERT — the verifyAuthority retrieve-path may write an
   *  existing PI's record after a Terminal restart. */
  insert(record: PaymentIntentRecord): Promise<void>;
  /** Look up by Stripe PI id. Returns null if no record exists. */
  get(piId: string): Promise<PaymentIntentRecord | null>;
}

/** One rejected-webhook audit record. Emitted whenever an inbound
 *  webhook fails signature verification (bad/forged signature, missing
 *  header, or no secret configured) so operators can alarm on it. Carries
 *  the Facet trace id but never the secret or the raw body. */
export interface WebhookRejection {
  readonly rail: string;
  readonly trace_id: string;
  readonly merchant_id: string;
  readonly site_id: string;
  /** Machine-readable cause: which gate rejected the webhook. */
  readonly reason: "missing_signature_header" | "secret_not_configured" | "signature_mismatch";
  /** Human-readable detail (safe to log — never includes the secret). */
  readonly detail: string;
}

/** Sink for webhook signature rejections. Injected so the Terminal can
 *  route these into its structured logger / alerting; defaults to a
 *  single `console.warn` line so a rejection is never silent. */
export type WebhookRejectionLogger = (rejection: WebhookRejection) => void;

export interface StripeAdapterConfig {
  /** Optional pre-constructed Stripe client. When omitted the adapter
   *  lazily instantiates one per-merchant from `merchant_config.api_key`.
   *  Pass an injected client for tests or for runtimes that need a
   *  custom HttpClient. */
  readonly stripe?: Stripe;
  /** Sink for webhook signature rejections (logged with the trace id).
   *  Defaults to a `console.warn` JSON line. */
  readonly webhookRejectionLogger?: WebhookRejectionLogger;
  /** Optional PaymentIntent-tracking store. When wired, the adapter
   *  writes a Facet-side identity record on every PI creation and
   *  rejects follow-up reserveAuthority / capture / refund calls whose
   *  (site_id, amount, currency, trace_id) tuple doesn't match. Absent
   *  = no cross-check (back-compat for tests + deployments that have
   *  not enabled the store). */
  readonly paymentIntentStore?: PaymentIntentStore;
  /** Override Date.now() — used for replay-protection windows. */
  readonly now?: () => number;
}

interface StripeMerchantConfig {
  /** Stripe secret key (`sk_live_...` or `sk_test_...`). */
  readonly api_key: string;
  /** Endpoint signing secret (`whsec_...`). Required for webhook
   *  verification; the adapter throws WEBHOOK_NOT_CONFIGURED if a
   *  webhook arrives without this set. */
  readonly webhook_secret?: string;
  /** Previous endpoint signing secret, honored during a zero-downtime
   *  secret rotation. When set, `handleWebhook` first tries
   *  `webhook_secret`, then falls back to this; a signature that matches
   *  either is accepted. Drop it once Stripe has finished re-signing with
   *  the new secret. */
  readonly webhook_secret_previous?: string;
  /** Optional Stripe Connect destination account. When set, the
   *  adapter routes calls through `Stripe-Account: <acct>` so the PI
   *  lives on the connected account. */
  readonly connect_account_id?: string;
  /** Optional platform application-fee in the smallest currency unit.
   *  Only honored when `connect_account_id` is also set. */
  readonly application_fee_minor?: number;
  /** Tolerance window (in seconds) for webhook signature verification.
   *  Default 300 (matches Stripe's library default). */
  readonly webhook_tolerance_seconds?: number;
}

export class StripeAdapter implements FacetPaymentRailAdapter {
  public readonly metadata: RailAdapterMetadata = {
    id: "card/stripe",
    display_name: "Stripe Cards / ACH / wallets",
    version: PACKAGE_VERSION,
    supports_reserve_capture: true,
    supports_refund: true,
    supports_dispute: true,
    networks: ["visa", "mastercard", "amex", "discover", "ach", "wallet"],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"],
    egress_allowlist: ["https://api.stripe.com"],
  };

  private readonly injectedStripe: Stripe | undefined;
  private readonly paymentIntentStore: PaymentIntentStore | undefined;
  private readonly logWebhookRejection: WebhookRejectionLogger;

  constructor(cfg: StripeAdapterConfig = {}) {
    this.injectedStripe = cfg.stripe;
    this.paymentIntentStore = cfg.paymentIntentStore;
    this.logWebhookRejection = cfg.webhookRejectionLogger ?? defaultWebhookRejectionLogger;
  }

  async verifyAuthority(
    input: VerifyAuthorityInput,
  ): Promise<RailAdapterResult<VerifyAuthorityOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;

    const { paymentMethod, existingPaymentIntent } = parseAuthority(input.authority);
    if (paymentMethod === undefined && existingPaymentIntent === undefined) {
      return errResult(
        "INVALID_REQUEST",
        "authority must contain either `payment_method` (pm_…) or `payment_intent` (pi_…)",
      );
    }

    const stripe = this.getClient(cfg.value);

    try {
      // Path A — caller already has a PI; we just retrieve + validate.
      if (existingPaymentIntent !== undefined) {
        const pi = await stripe.paymentIntents.retrieve(
          existingPaymentIntent,
          undefined,
          requestOptionsFor(cfg.value, input.ctx),
        );
        const validated = validateRetrievedIntent(pi, input);
        if (validated.kind !== "ok") return validated;
        // cross-check Facet-side identity. If a record already
        // exists for this PI, it MUST match the current request's
        // (site, amount, currency, trace) — otherwise this is a
        // cross-site / cross-trace replay attempt.
        const crossCheck = await this.crossCheckByPiId(pi.id, input.ctx, input.amount);
        if (crossCheck.kind !== "ok") return crossCheck;
        return validated;
      }

      // Path B — create a manual-capture PI with the supplied PM.
      const pi = await stripe.paymentIntents.create(
        buildCreateParams(input, cfg.value, paymentMethod!),
        requestOptionsFor(cfg.value, input.ctx),
      );
      // record the Facet-side identity tuple immediately. If
      // the store write fails we'd rather error than ship a PI without
      // its tracking row (the cross-check on follow-ups would then
      // accept any caller). Store errors are mapped to INTERNAL_ERROR
      // — the operator should see the failure and either disable the
      // store or fix the DB connectivity.
      if (this.paymentIntentStore !== undefined) {
        try {
          await this.paymentIntentStore.insert({
            stripe_payment_intent_id: pi.id,
            site_id: input.ctx.site_id,
            expected_amount_minor: input.amount.amount,
            expected_currency: input.amount.currency.toUpperCase(),
            facet_trace_id: input.ctx.trace_id,
          });
        } catch (e) {
          return errResult(
            "INTERNAL_ERROR",
            `PI tracking store write failed for ${pi.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return {
        kind: "ok",
        value: {
          authority_handle: pi.id,
          expires_at: null,
        },
      };
    } catch (e) {
      return mapStripeError(e, "verifyAuthority");
    }
  }

  /** Cross-check: verify that the (site_id, amount, currency,
   *  trace_id) tuple on the inbound request matches what we recorded
   *  at PI-create time. Called from verifyAuthority Path A
   *  (retrieve-existing) and from every follow-up op. Returns ok if
   *  the store is unwired (back-compat for tests + deployments that
   *  have not enabled the store). For follow-up ops whose store has no
   *  record yet, the call is treated as a backfill rather than a
   *  rejection — Stripe's own state machine is the authoritative gate
   *  on what's valid; we only add Facet-side cross-tenant +
   *  cross-trace defense. */
  private async crossCheckByPiId(
    piId: string,
    ctx: { readonly site_id: string; readonly trace_id: string },
    amount: { readonly amount: number; readonly currency: string } | undefined,
  ): Promise<RailAdapterResult<never> | { kind: "ok" }> {
    if (this.paymentIntentStore === undefined) return { kind: "ok" };
    const record = await this.paymentIntentStore.get(piId);
    if (record === null) {
      // First time we've seen this PI through the store — backfill so
      // subsequent ops can cross-check. This handles the bootstrap
      // case where PIs predating the store come through.
      if (amount === undefined) return { kind: "ok" };
      await this.paymentIntentStore.insert({
        stripe_payment_intent_id: piId,
        site_id: ctx.site_id,
        expected_amount_minor: amount.amount,
        expected_currency: amount.currency.toUpperCase(),
        facet_trace_id: ctx.trace_id,
      });
      return { kind: "ok" };
    }
    if (record.site_id !== ctx.site_id) {
      return errResult(
        "UNAUTHORIZED",
        `PaymentIntent ${piId} belongs to a different site — cross-site PI access blocked.`,
      );
    }
    if (amount !== undefined && record.expected_amount_minor !== amount.amount) {
      return errResult(
        "INVALID_REQUEST",
        `PaymentIntent ${piId} expected amount ${record.expected_amount_minor} does not match request ${amount.amount}.`,
      );
    }
    if (amount !== undefined && record.expected_currency !== amount.currency.toUpperCase()) {
      return errResult(
        "INVALID_REQUEST",
        `PaymentIntent ${piId} expected currency ${record.expected_currency} does not match request ${amount.currency.toUpperCase()}.`,
      );
    }
    if (record.facet_trace_id !== ctx.trace_id) {
      return errResult(
        "UNAUTHORIZED",
        `PaymentIntent ${piId} was created for a different Facet trace — cross-trace PI replay blocked.`,
      );
    }
    return { kind: "ok" };
  }

  async reserveAuthority(
    input: ReserveAuthorityInput,
  ): Promise<RailAdapterResult<ReserveAuthorityOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;
    // cross-check Facet identity BEFORE round-tripping to
    // Stripe. A cross-site / cross-trace caller is rejected without
    // ever revealing the PI's existence to them.
    const xc = await this.crossCheckByPiId(input.authority_handle, input.ctx, input.amount);
    if (xc.kind !== "ok") return xc;
    const stripe = this.getClient(cfg.value);
    try {
      const pi = await stripe.paymentIntents.retrieve(
        input.authority_handle,
        undefined,
        requestOptionsFor(cfg.value, input.ctx),
      );
      if (pi.status !== "requires_capture" && pi.status !== "succeeded") {
        return errResult(
          "INVALID_REQUEST",
          `PaymentIntent ${pi.id} is in status "${pi.status}" — reserve requires requires_capture`,
        );
      }
      return {
        kind: "ok",
        value: {
          reservation_active: pi.status === "requires_capture",
          reserved_until: null,
        },
      };
    } catch (e) {
      return mapStripeError(e, "reserveAuthority");
    }
  }

  async capture(input: CaptureInput): Promise<RailAdapterResult<CaptureOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;
    // cross-check Facet identity BEFORE the capture call.
    const xc = await this.crossCheckByPiId(input.authority_handle, input.ctx, input.amount);
    if (xc.kind !== "ok") return xc;
    const stripe = this.getClient(cfg.value);
    try {
      const pi = await stripe.paymentIntents.capture(
        input.authority_handle,
        { amount_to_capture: input.amount.amount },
        requestOptionsFor(cfg.value, input.ctx),
      );
      const chargeId = extractChargeId(pi);
      return {
        kind: "ok",
        value: {
          settlement_id: chargeId ?? pi.id,
          settled_at: new Date().toISOString(),
        },
      };
    } catch (e) {
      return mapStripeError(e, "capture");
    }
  }

  async refund(input: RefundInput): Promise<RailAdapterResult<RefundOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;
    // refund.settlement_id may be a charge id (ch_...) or a
    // payment_intent id (pi_...). Cross-check only applies on the pi_
    // path — charge ids aren't tracked. Refund amount may be less than
    // the original auth (partial refund), so we pass undefined for the
    // amount and let Stripe's own state machine enforce the
    // amount-must-not-exceed-captured invariant.
    if (input.settlement_id.startsWith("pi_")) {
      const xc = await this.crossCheckByPiId(input.settlement_id, input.ctx, undefined);
      if (xc.kind !== "ok") return xc;
    }
    const stripe = this.getClient(cfg.value);
    try {
      const reason = mapRefundReason(input.reason);
      const refund = await stripe.refunds.create(
        {
          ...(input.settlement_id.startsWith("ch_")
            ? { charge: input.settlement_id }
            : { payment_intent: input.settlement_id }),
          amount: input.amount.amount,
          ...(reason !== undefined ? { reason } : {}),
          metadata: { facet_trace_id: input.ctx.trace_id, facet_reason: input.reason },
        },
        requestOptionsFor(cfg.value, input.ctx),
      );
      return {
        kind: "ok",
        value: {
          refund_id: refund.id,
          refunded_at: new Date(refund.created * 1000).toISOString(),
        },
      };
    } catch (e) {
      return mapStripeError(e, "refund");
    }
  }

  async dispute(input: DisputeInput): Promise<RailAdapterResult<DisputeOk>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;
    const stripe = this.getClient(cfg.value);
    try {
      let dispute: Stripe.Dispute;
      if (input.action === "accept") {
        dispute = await stripe.disputes.close(
          input.settlement_id,
          undefined,
          requestOptionsFor(cfg.value, input.ctx),
        );
      } else {
        const evidence =
          input.evidence !== undefined
            ? (input.evidence as Stripe.DisputeUpdateParams.Evidence)
            : undefined;
        dispute = await stripe.disputes.update(
          input.settlement_id,
          {
            ...(evidence !== undefined ? { evidence } : {}),
            submit: true,
          },
          requestOptionsFor(cfg.value, input.ctx),
        );
      }
      return {
        kind: "ok",
        value: {
          dispute_id: dispute.id,
          status: mapDisputeStatus(dispute.status),
        },
      };
    } catch (e) {
      return mapStripeError(e, "dispute");
    }
  }

  async handleWebhook(input: WebhookRequest): Promise<RailAdapterResult<WebhookOutcome>> {
    const cfg = readMerchantConfig(input.merchant_config);
    if (cfg.kind === "error") return cfg.error;
    if (cfg.value.webhook_secret === undefined) {
      this.rejectWebhook(input, "secret_not_configured", "merchant_config.webhook_secret is unset");
      return errResult(
        "INVALID_REQUEST",
        "merchant_config.webhook_secret is required to verify Stripe webhooks",
      );
    }
    const stripe = this.getClient(cfg.value);
    const sigHeader = input.headers["stripe-signature"] ?? input.headers["Stripe-Signature"];
    if (typeof sigHeader !== "string") {
      this.rejectWebhook(input, "missing_signature_header", "stripe-signature header is missing");
      return errResult("UNAUTHORIZED", "stripe-signature header is missing");
    }

    // Versioned-secret support: accept a signature that matches the
    // current OR the previous endpoint secret, so a `whsec_…` rotation
    // does not drop in-flight webhooks. Stripe re-signs new events with
    // the new secret while still-queued retries carry the old one.
    const tolerance = cfg.value.webhook_tolerance_seconds ?? 300;
    const rawBody = Buffer.from(input.raw_body);
    const secrets: readonly string[] = [
      cfg.value.webhook_secret,
      ...(cfg.value.webhook_secret_previous !== undefined
        ? [cfg.value.webhook_secret_previous]
        : []),
    ];

    let event: Stripe.Event | undefined;
    let lastError = "";
    for (const secret of secrets) {
      try {
        event = await stripe.webhooks.constructEventAsync(rawBody, sigHeader, secret, tolerance);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    if (event === undefined) {
      this.rejectWebhook(
        input,
        "signature_mismatch",
        `signature did not match any configured secret: ${lastError}`,
      );
      return makeError(
        "UNAUTHORIZED",
        `Webhook signature verification failed: ${lastError}`,
        false,
        "signature_verification_failed",
      );
    }

    return { kind: "ok", value: mapEventToOutcome(event) };
  }

  /** Emit a structured rejection record (with the trace id) and never
   *  let a logger throw bubble into the request path. */
  private rejectWebhook(
    input: WebhookRequest,
    reason: WebhookRejection["reason"],
    detail: string,
  ): void {
    try {
      this.logWebhookRejection({
        rail: this.metadata.id,
        trace_id: input.ctx.trace_id,
        merchant_id: input.ctx.merchant_id,
        site_id: input.ctx.site_id,
        reason,
        detail,
      });
    } catch {
      // a misbehaving logger must not turn a rejected webhook into a 500
    }
  }

  private getClient(cfg: StripeMerchantConfig): Stripe {
    if (this.injectedStripe !== undefined) return this.injectedStripe;
    return new Stripe(cfg.api_key, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      maxNetworkRetries: 2,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — keep these in this file so the adapter is one self-contained
// unit. The Terminal imports only `StripeAdapter` plus the package
// metadata.
// ─────────────────────────────────────────────────────────────────────────────

/** Default rejection sink: a single structured `console.warn` line so a
 *  rejected webhook is never silently dropped even when the Terminal
 *  does not inject its own logger. Never logs the secret or raw body. */
const defaultWebhookRejectionLogger: WebhookRejectionLogger = (rejection) => {
  console.warn(JSON.stringify({ event: "webhook_signature_rejected", ...rejection }));
};

interface ConfigOk {
  readonly kind: "ok";
  readonly value: StripeMerchantConfig;
}
interface ConfigError {
  readonly kind: "error";
  readonly error: RailAdapterResult<never>;
}

function readMerchantConfig(cfg: MerchantConfig): ConfigOk | ConfigError {
  const api_key = cfg.api_key;
  if (typeof api_key !== "string" || api_key === "") {
    return {
      kind: "error",
      error: errResult(
        "INVALID_REQUEST",
        "merchant_config.api_key (Stripe secret key) is required",
      ),
    };
  }
  const value: StripeMerchantConfig = {
    api_key,
    ...(typeof cfg.webhook_secret === "string" ? { webhook_secret: cfg.webhook_secret } : {}),
    ...(typeof cfg.webhook_secret_previous === "string"
      ? { webhook_secret_previous: cfg.webhook_secret_previous }
      : {}),
    ...(typeof cfg.connect_account_id === "string"
      ? { connect_account_id: cfg.connect_account_id }
      : {}),
    ...(typeof cfg.application_fee_minor === "number"
      ? { application_fee_minor: cfg.application_fee_minor }
      : {}),
    ...(typeof cfg.webhook_tolerance_seconds === "number"
      ? { webhook_tolerance_seconds: cfg.webhook_tolerance_seconds }
      : {}),
  };
  return { kind: "ok", value };
}

function parseAuthority(authority: Readonly<Record<string, unknown>>): {
  paymentMethod: string | undefined;
  existingPaymentIntent: string | undefined;
} {
  const pm = authority.payment_method;
  const pi = authority.payment_intent;
  return {
    paymentMethod: typeof pm === "string" && pm !== "" ? pm : undefined,
    existingPaymentIntent: typeof pi === "string" && pi !== "" ? pi : undefined,
  };
}

function buildCreateParams(
  input: VerifyAuthorityInput,
  cfg: StripeMerchantConfig,
  paymentMethod: string,
): Stripe.PaymentIntentCreateParams {
  return {
    amount: input.amount.amount,
    currency: input.amount.currency.toLowerCase(),
    capture_method: "manual",
    payment_method: paymentMethod,
    confirm: true,
    off_session: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: {
      facet_trace_id: input.ctx.trace_id,
      facet_idempotency_key: input.ctx.idempotency_key,
      facet_merchant_id: input.ctx.merchant_id,
      facet_site_id: input.ctx.site_id,
    },
    // Direct charges: PI is created on the connected account via
    // `stripeAccount` in request options (see requestOptionsFor).
    // `application_fee_amount` here instructs Stripe to atomically
    // route the platform fee to Facet's account. Do NOT add
    // `transfer_data.destination` — that switches to destination
    // charges and would route money through Facet's platform account
    // first, breaking the non-custodial invariant.
    ...(cfg.connect_account_id !== undefined && cfg.application_fee_minor !== undefined
      ? { application_fee_amount: cfg.application_fee_minor }
      : {}),
  };
}

function requestOptionsFor(
  cfg: StripeMerchantConfig,
  ctx: { readonly idempotency_key: string },
): Stripe.RequestOptions {
  return {
    idempotencyKey: ctx.idempotency_key,
    ...(cfg.connect_account_id !== undefined ? { stripeAccount: cfg.connect_account_id } : {}),
  };
}

function validateRetrievedIntent(
  pi: Stripe.PaymentIntent,
  input: VerifyAuthorityInput,
): RailAdapterResult<VerifyAuthorityOk> {
  if (pi.amount !== input.amount.amount) {
    return errResult(
      "INVALID_REQUEST",
      `PaymentIntent amount (${pi.amount}) does not match requested amount (${input.amount.amount})`,
    );
  }
  if (pi.currency.toLowerCase() !== input.amount.currency.toLowerCase()) {
    return errResult(
      "INVALID_REQUEST",
      `PaymentIntent currency (${pi.currency}) does not match requested currency (${input.amount.currency})`,
    );
  }
  if (pi.status === "canceled" || pi.status === "requires_payment_method") {
    return errResult(
      "UNAUTHORIZED",
      `PaymentIntent ${pi.id} is in non-actionable status "${pi.status}"`,
    );
  }
  return {
    kind: "ok",
    value: { authority_handle: pi.id, expires_at: null },
  };
}

function extractChargeId(pi: Stripe.PaymentIntent): string | null {
  if (pi.latest_charge === null || pi.latest_charge === undefined) return null;
  return typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
}

function mapRefundReason(reason: string): Stripe.RefundCreateParams.Reason | undefined {
  if (reason === "duplicate" || reason === "fraudulent") return reason;
  return "requested_by_customer";
}

function mapDisputeStatus(status: Stripe.Dispute.Status): "open" | "won" | "lost" | "withdrawn" {
  switch (status) {
    case "won":
      return "won";
    case "lost":
      return "lost";
    case "warning_closed":
    case "warning_under_review":
    case "warning_needs_response":
      return "open";
    default:
      return "open";
  }
}

function mapEventToOutcome(event: Stripe.Event): WebhookOutcome {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const chargeId = extractChargeId(pi);
      return {
        kind: "settlement_confirmed",
        settlement_id: chargeId ?? pi.id,
        confirmed_at: new Date(event.created * 1000).toISOString(),
      };
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const refundList = charge.refunds;
      const lastRefund =
        refundList !== null && typeof refundList === "object" && Array.isArray(refundList.data)
          ? refundList.data[refundList.data.length - 1]
          : undefined;
      return {
        kind: "refund_completed",
        refund_id: lastRefund?.id ?? charge.id,
        settlement_id: charge.id,
        refunded_at: new Date(event.created * 1000).toISOString(),
      };
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId =
        typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? dispute.id);
      return {
        kind: "dispute_opened",
        dispute_id: dispute.id,
        settlement_id: chargeId,
        opened_at: new Date(event.created * 1000).toISOString(),
        amount: { amount: dispute.amount, currency: dispute.currency.toUpperCase() },
        reason_code: dispute.reason,
      };
    }
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      return {
        kind: "dispute_resolved",
        dispute_id: dispute.id,
        resolution:
          dispute.status === "won" ? "won" : dispute.status === "lost" ? "lost" : "withdrawn",
        resolved_at: new Date(event.created * 1000).toISOString(),
      };
    }
    default:
      return { kind: "ignored", reason: `event type ${event.type} not mapped` };
  }
}

function mapStripeError(e: unknown, op: string): RailAdapterResult<never> {
  if (e instanceof Stripe.errors.StripeRateLimitError) {
    return { kind: "rate_limited", retry_after_seconds: 5 };
  }
  if (e instanceof Stripe.errors.StripeAuthenticationError) {
    return makeError(
      "UNAUTHORIZED",
      `Stripe authentication failed (${op}): ${e.message}`,
      false,
      e.code ?? null,
    );
  }
  if (e instanceof Stripe.errors.StripeCardError) {
    return makeError(
      "SETTLEMENT_FAILED",
      `Card declined (${op}): ${e.message}`,
      false,
      e.code ?? e.decline_code ?? null,
    );
  }
  if (e instanceof Stripe.errors.StripeIdempotencyError) {
    return makeError(
      "INVALID_REQUEST",
      `Stripe idempotency conflict (${op}): ${e.message}`,
      false,
      e.code ?? null,
    );
  }
  if (e instanceof Stripe.errors.StripeInvalidRequestError) {
    return makeError(
      "INVALID_REQUEST",
      `Stripe rejected the request (${op}): ${e.message}`,
      false,
      e.code ?? null,
    );
  }
  if (
    e instanceof Stripe.errors.StripeAPIError ||
    e instanceof Stripe.errors.StripeConnectionError
  ) {
    return makeError(
      "SETTLEMENT_FAILED",
      `Stripe transient error (${op}): ${e.message}`,
      true,
      e.code ?? null,
    );
  }
  if (e instanceof Stripe.errors.StripeError) {
    return makeError(
      "SETTLEMENT_FAILED",
      `Stripe error (${op}): ${e.message}`,
      false,
      e.code ?? null,
    );
  }
  return makeError(
    "SETTLEMENT_FAILED",
    `Unexpected error (${op}): ${e instanceof Error ? e.message : String(e)}`,
    true,
    null,
  );
}

type StripeErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "SETTLEMENT_FAILED"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

function errResult(code: StripeErrorCode, message: string): RailAdapterResult<never> {
  return { kind: "error", code, message, retryable: false };
}

function makeError(
  code: StripeErrorCode,
  message: string,
  retryable: boolean,
  nativeCode: string | null | undefined,
): RailAdapterResult<never> {
  return nativeCode
    ? { kind: "error", code, message, retryable, native_code: nativeCode }
    : { kind: "error", code, message, retryable };
}
