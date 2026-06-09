// Stripe adapter tests use an injected Stripe client whose methods are
// vitest mocks. We exercise the real adapter code paths (verifyAuthority,
// reserveAuthority, capture, refund, dispute, handleWebhook) end-to-end
// — only the network boundary is stubbed.

import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

import {
  StripeAdapter,
  type PaymentIntentRecord,
  type PaymentIntentStore,
  type WebhookRejection,
} from "../src/adapter.ts";

// In-memory PaymentIntentStore for the cross-check tests. The
// production wiring uses a database-backed implementation (see
// the database-backed store); this mock matches the same interface.
function makeMemoryStore(seed: PaymentIntentRecord[] = []): PaymentIntentStore & {
  rows: Map<string, PaymentIntentRecord>;
  inserts: number;
} {
  const rows = new Map<string, PaymentIntentRecord>();
  for (const r of seed) rows.set(r.stripe_payment_intent_id, r);
  let inserts = 0;
  return {
    rows,
    get inserts() {
      return inserts;
    },
    async insert(record) {
      rows.set(record.stripe_payment_intent_id, record);
      inserts += 1;
    },
    async get(piId) {
      return rows.get(piId) ?? null;
    },
  };
}

const ctx = {
  trace_id: "trace_test",
  idempotency_key: "idem_test",
  merchant_id: "merch_test",
  site_id: "site_test",
  received_at: "2026-05-24T00:00:00Z",
};

const merchantConfig = {
  api_key: "sk_test_stub",
  webhook_secret: "whsec_test",
  connect_account_id: "acct_test_stub",
  application_fee_minor: 100,
};

function makeStubStripe(
  overrides: Record<string, Record<string, (...args: unknown[]) => unknown>> = {},
): Stripe {
  const stub = {
    paymentIntents: {
      create: vi.fn(),
      retrieve: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
      confirm: vi.fn(),
    },
    refunds: {
      create: vi.fn(),
    },
    disputes: {
      update: vi.fn(),
      close: vi.fn(),
    },
    webhooks: {
      constructEventAsync: vi.fn(),
      generateTestHeaderStringAsync: vi.fn(),
    },
  };
  for (const [resource, methods] of Object.entries(overrides)) {
    for (const [method, impl] of Object.entries(methods)) {
      (stub as Record<string, Record<string, unknown>>)[resource]![method] = impl;
    }
  }
  return stub as unknown as Stripe;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter metadata", () => {
  it("declares card/stripe with two-step capture, refund, and dispute support", () => {
    const adapter = new StripeAdapter();
    expect(adapter.metadata.id).toBe("card/stripe");
    expect(adapter.metadata.supports_reserve_capture).toBe(true);
    expect(adapter.metadata.supports_refund).toBe(true);
    expect(adapter.metadata.supports_dispute).toBe(true);
    expect(adapter.metadata.egress_allowlist).toEqual(["https://api.stripe.com"]);
    expect(adapter.metadata.currencies).toContain("USD");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyAuthority
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.verifyAuthority", () => {
  it("creates a manual-capture PaymentIntent when payment_method is supplied", async () => {
    const create = vi.fn().mockResolvedValue({ id: "pi_test_123", status: "requires_capture" });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { create } }),
    });

    const result = await adapter.verifyAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority: { payment_method: "pm_test_card" },
      amount: { amount: 1999, currency: "USD" },
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.authority_handle).toBe("pi_test_123");
    expect(create).toHaveBeenCalledOnce();
    const [params, options] = create.mock.calls[0]!;
    expect(params.capture_method).toBe("manual");
    expect(params.amount).toBe(1999);
    expect(params.currency).toBe("usd");
    expect(params.payment_method).toBe("pm_test_card");
    // Non-custodial invariant (locked 2026-05-24): direct charges via
    // `stripeAccount` option, NOT destination charges via transfer_data.
    // Money lands on the merchant's connected account; Facet collects
    // its fee atomically via application_fee_amount without holding
    // the customer's money.
    expect(params.transfer_data).toBeUndefined();
    expect(params.application_fee_amount).toBe(100);
    expect(params.metadata.facet_trace_id).toBe(ctx.trace_id);
    expect(options.idempotencyKey).toBe(ctx.idempotency_key);
    expect(options.stripeAccount).toBe(merchantConfig.connect_account_id);
  });

  it("retrieves an existing PaymentIntent when payment_intent is supplied", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_test_existing",
      status: "requires_capture",
      amount: 1999,
      currency: "usd",
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
    });

    const result = await adapter.verifyAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority: { payment_intent: "pi_test_existing" },
      amount: { amount: 1999, currency: "USD" },
    });

    expect(result.kind).toBe("ok");
    expect(retrieve).toHaveBeenCalledWith("pi_test_existing", expect.any(Object));
  });

  it("rejects when the retrieved PI's amount disagrees with the requested amount", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_test_x",
      status: "requires_capture",
      amount: 500,
      currency: "usd",
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
    });

    const result = await adapter.verifyAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority: { payment_intent: "pi_test_x" },
      amount: { amount: 1999, currency: "USD" },
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });

  it("rejects when neither payment_method nor payment_intent is present", async () => {
    const adapter = new StripeAdapter({ stripe: makeStubStripe() });
    const result = await adapter.verifyAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority: { something_else: "x" },
      amount: { amount: 100, currency: "USD" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });

  it("rejects when merchant_config.api_key is missing", async () => {
    const adapter = new StripeAdapter({ stripe: makeStubStripe() });
    const result = await adapter.verifyAuthority({
      ctx,
      merchant_config: {},
      authority: { payment_method: "pm_x" },
      amount: { amount: 100, currency: "USD" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// capture
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.capture", () => {
  it("calls paymentIntents.capture and returns the latest charge id", async () => {
    const capture = vi.fn().mockResolvedValue({
      id: "pi_test_x",
      status: "succeeded",
      latest_charge: "ch_test_777",
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
    });

    const result = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_test_x",
      amount: { amount: 1999, currency: "USD" },
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.settlement_id).toBe("ch_test_777");
    expect(capture).toHaveBeenCalledWith(
      "pi_test_x",
      { amount_to_capture: 1999 },
      expect.objectContaining({ idempotencyKey: ctx.idempotency_key }),
    );
  });

  it("returns SETTLEMENT_FAILED when Stripe declines the card", async () => {
    const capture = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeCardError({
        type: "card_error",
        code: "card_declined",
        message: "Your card was declined.",
        decline_code: "generic_decline",
      } as Stripe.StripeRawError),
    );
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
    });
    const result = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_test_x",
      amount: { amount: 1999, currency: "USD" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("SETTLEMENT_FAILED");
      expect(result.native_code).toBe("card_declined");
    }
  });

  it("returns rate_limited on a StripeRateLimitError", async () => {
    const capture = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeRateLimitError({
        type: "rate_limit_error",
        message: "Too many requests",
      } as Stripe.StripeRawError),
    );
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
    });
    const result = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_test_x",
      amount: { amount: 1999, currency: "USD" },
    });
    expect(result.kind).toBe("rate_limited");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reserveAuthority
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.reserveAuthority", () => {
  it("reports reservation_active true when the PI is requires_capture", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_x",
      status: "requires_capture",
      amount: 100,
      currency: "usd",
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
    });
    const result = await adapter.reserveAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_x",
      amount: { amount: 100, currency: "USD" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.reservation_active).toBe(true);
  });

  it("rejects when the PI is in an unexpected status", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_x",
      status: "requires_action",
      amount: 100,
      currency: "usd",
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
    });
    const result = await adapter.reserveAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_x",
      amount: { amount: 100, currency: "USD" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refund
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.refund", () => {
  it("creates a Refund against a payment_intent and returns the refund id", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "re_test_555",
      created: 1730000000,
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ refunds: { create } }),
    });
    const result = await adapter.refund({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "pi_test_x",
      amount: { amount: 500, currency: "USD" },
      reason: "requested_by_customer",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.refund_id).toBe("re_test_555");
    const [params] = create.mock.calls[0]!;
    expect(params.payment_intent).toBe("pi_test_x");
    expect(params.amount).toBe(500);
    expect(params.reason).toBe("requested_by_customer");
    expect(params.metadata.facet_reason).toBe("requested_by_customer");
  });

  it("routes a ch_-prefixed settlement_id to the `charge` field", async () => {
    const create = vi.fn().mockResolvedValue({ id: "re_x", created: 1 });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ refunds: { create } }),
    });
    await adapter.refund({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "ch_test_777",
      amount: { amount: 500, currency: "USD" },
      reason: "duplicate",
    });
    const [params] = create.mock.calls[0]!;
    expect(params.charge).toBe("ch_test_777");
    expect(params.payment_intent).toBeUndefined();
    expect(params.reason).toBe("duplicate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispute
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.dispute", () => {
  it("uses disputes.update + submit=true for 'challenge'", async () => {
    const update = vi.fn().mockResolvedValue({ id: "du_x", status: "warning_under_review" });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ disputes: { update } }),
    });
    const result = await adapter.dispute!({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "du_x",
      action: "challenge",
      evidence: { customer_email_address: "agent@example.com" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.status).toBe("open");
    const [, params] = update.mock.calls[0]!;
    expect(params.submit).toBe(true);
    expect(params.evidence.customer_email_address).toBe("agent@example.com");
  });

  it("uses disputes.close for 'accept'", async () => {
    const close = vi.fn().mockResolvedValue({ id: "du_x", status: "lost" });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ disputes: { close } }),
    });
    const result = await adapter.dispute!({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "du_x",
      action: "accept",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.status).toBe("lost");
    expect(close).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleWebhook
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.handleWebhook", () => {
  it("verifies signature via stripe.webhooks.constructEventAsync and maps PI success", async () => {
    const constructEventAsync = vi.fn().mockResolvedValue({
      type: "payment_intent.succeeded",
      created: 1730000000,
      data: {
        object: { id: "pi_x", latest_charge: "ch_x", status: "succeeded" },
      },
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: merchantConfig,
      raw_body: new TextEncoder().encode("body"),
      parsed_body: { id: "evt_x" },
      headers: { "stripe-signature": "t=1,v1=abc" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok" && result.value.kind === "settlement_confirmed") {
      expect(result.value.settlement_id).toBe("ch_x");
    }
    expect(constructEventAsync).toHaveBeenCalledOnce();
  });

  it("maps charge.refunded to a refund_completed outcome", async () => {
    const constructEventAsync = vi.fn().mockResolvedValue({
      type: "charge.refunded",
      created: 1730000000,
      data: {
        object: {
          id: "ch_x",
          refunds: { data: [{ id: "re_1" }, { id: "re_2" }] },
        },
      },
    });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: merchantConfig,
      raw_body: new TextEncoder().encode("body"),
      parsed_body: {},
      headers: { "stripe-signature": "x" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok" && result.value.kind === "refund_completed") {
      expect(result.value.refund_id).toBe("re_2");
    }
  });

  it("returns UNAUTHORIZED when signature verification fails", async () => {
    const constructEventAsync = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeSignatureVerificationError({
        type: "authentication_error",
        message: "No signatures found matching the expected signature for payload",
      } as Stripe.StripeRawError),
    );
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: merchantConfig,
      raw_body: new TextEncoder().encode("body"),
      parsed_body: null,
      headers: { "stripe-signature": "x" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("UNAUTHORIZED");
  });

  it("returns INVALID_REQUEST when webhook_secret is not configured", async () => {
    const adapter = new StripeAdapter({ stripe: makeStubStripe() });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: { api_key: "sk_test_x" },
      raw_body: new TextEncoder().encode("body"),
      parsed_body: null,
      headers: { "stripe-signature": "x" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });

  it("returns UNAUTHORIZED when stripe-signature header is missing", async () => {
    const adapter = new StripeAdapter({ stripe: makeStubStripe() });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: merchantConfig,
      raw_body: new TextEncoder().encode("body"),
      parsed_body: null,
      headers: {},
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("UNAUTHORIZED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// versioned webhook secrets (zero-downtime rotation) + rejection logging
// ─────────────────────────────────────────────────────────────────────────────

describe("StripeAdapter.handleWebhook versioned secrets", () => {
  // Models the Stripe SDK: constructEventAsync succeeds only when the
  // secret argument equals `goodSecret`; otherwise it throws the same
  // signature error the real SDK raises.
  const constructEventFor = (goodSecret: string) =>
    vi.fn(async (_body: unknown, _sig: unknown, secret: unknown) => {
      if (secret !== goodSecret) {
        throw new Stripe.errors.StripeSignatureVerificationError({
          type: "authentication_error",
          message: "No signatures found matching the expected signature for payload",
        } as Stripe.StripeRawError);
      }
      return {
        type: "payment_intent.succeeded",
        created: 1730000000,
        data: { object: { id: "pi_x", latest_charge: "ch_x", status: "succeeded" } },
      } as unknown as Stripe.Event;
    });

  it("accepts a signature that matches the current secret", async () => {
    const constructEventAsync = constructEventFor("whsec_current");
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: {
        api_key: "sk_test_x",
        webhook_secret: "whsec_current",
        webhook_secret_previous: "whsec_old",
      },
      raw_body: new TextEncoder().encode("body"),
      parsed_body: { id: "evt_x" },
      headers: { "stripe-signature": "t=1,v1=abc" },
    });
    expect(result.kind).toBe("ok");
    // current secret matched on the first try — no fallback needed
    expect(constructEventAsync).toHaveBeenCalledOnce();
  });

  it("falls back to the previous secret during a rotation", async () => {
    const constructEventAsync = constructEventFor("whsec_old");
    const rejections: WebhookRejection[] = [];
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
      webhookRejectionLogger: (r) => rejections.push(r),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: {
        api_key: "sk_test_x",
        webhook_secret: "whsec_current",
        webhook_secret_previous: "whsec_old",
      },
      raw_body: new TextEncoder().encode("body"),
      parsed_body: { id: "evt_x" },
      headers: { "stripe-signature": "t=1,v1=abc" },
    });
    expect(result.kind).toBe("ok");
    // tried current (failed) then previous (succeeded)
    expect(constructEventAsync).toHaveBeenCalledTimes(2);
    // a successful fallback is NOT a rejection
    expect(rejections).toHaveLength(0);
  });

  it("rejects and logs when the signature matches neither secret", async () => {
    const constructEventAsync = constructEventFor("whsec_neither");
    const rejections: WebhookRejection[] = [];
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ webhooks: { constructEventAsync } }),
      webhookRejectionLogger: (r) => rejections.push(r),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: {
        api_key: "sk_test_x",
        webhook_secret: "whsec_current",
        webhook_secret_previous: "whsec_old",
      },
      raw_body: new TextEncoder().encode("body"),
      parsed_body: null,
      headers: { "stripe-signature": "t=1,v1=abc" },
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("UNAUTHORIZED");
    // both secrets were tried before rejecting
    expect(constructEventAsync).toHaveBeenCalledTimes(2);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      rail: "card/stripe",
      trace_id: "trace_test",
      reason: "signature_mismatch",
    });
  });

  it("logs a rejection (with trace id) when the signature header is missing", async () => {
    const rejections: WebhookRejection[] = [];
    const adapter = new StripeAdapter({
      stripe: makeStubStripe(),
      webhookRejectionLogger: (r) => rejections.push(r),
    });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: merchantConfig,
      raw_body: new TextEncoder().encode("body"),
      parsed_body: null,
      headers: {},
    });
    expect(result.kind).toBe("error");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      trace_id: "trace_test",
      reason: "missing_signature_header",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Facet-side PaymentIntent identity cross-check
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentIntentStore cross-check", () => {
  it("verifyAuthority writes a tracking record on PI creation", async () => {
    const create = vi.fn().mockResolvedValue({ id: "pi_new_42", status: "requires_capture" });
    const store = makeMemoryStore();
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { create } }),
      paymentIntentStore: store,
    });
    const r = await adapter.verifyAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority: { payment_method: "pm_test" },
      amount: { amount: 1999, currency: "USD" },
    });
    expect(r.kind).toBe("ok");
    expect(store.rows.get("pi_new_42")).toEqual({
      stripe_payment_intent_id: "pi_new_42",
      site_id: "site_test",
      expected_amount_minor: 1999,
      expected_currency: "USD",
      facet_trace_id: "trace_test",
    });
  });

  it("verifyAuthority Path A (retrieve existing PI) rejects cross-site reuse with UNAUTHORIZED", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "pi_victim_99",
      status: "requires_capture",
      amount: 1999,
      currency: "usd",
    });
    const store = makeMemoryStore([
      {
        stripe_payment_intent_id: "pi_victim_99",
        site_id: "site_victim",
        expected_amount_minor: 1999,
        expected_currency: "USD",
        facet_trace_id: "trace_victim",
      },
    ]);
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
      paymentIntentStore: store,
    });
    const r = await adapter.verifyAuthority({
      ctx, // ctx.site_id = 'site_test' — DIFFERENT from the seeded record
      merchant_config: merchantConfig,
      authority: { payment_intent: "pi_victim_99" },
      amount: { amount: 1999, currency: "USD" },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("UNAUTHORIZED");
      expect(r.message).toContain("different site");
    }
  });

  it("capture rejects amount mismatch with INVALID_REQUEST", async () => {
    const capture = vi.fn(); // should NOT be called
    const store = makeMemoryStore([
      {
        stripe_payment_intent_id: "pi_legit",
        site_id: "site_test",
        expected_amount_minor: 1999, // recorded at verifyAuthority time
        expected_currency: "USD",
        facet_trace_id: "trace_test",
      },
    ]);
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
      paymentIntentStore: store,
    });
    const r = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_legit",
      amount: { amount: 9999, currency: "USD" }, // mismatch
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("INVALID_REQUEST");
    expect(capture).not.toHaveBeenCalled();
  });

  it("capture rejects cross-trace replay with UNAUTHORIZED", async () => {
    const capture = vi.fn();
    const store = makeMemoryStore([
      {
        stripe_payment_intent_id: "pi_legit_trace_a",
        site_id: "site_test",
        expected_amount_minor: 1999,
        expected_currency: "USD",
        facet_trace_id: "trace_A_legit",
      },
    ]);
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
      paymentIntentStore: store,
    });
    const r = await adapter.capture({
      ctx: { ...ctx, trace_id: "trace_B_attacker" }, // different trace
      merchant_config: merchantConfig,
      authority_handle: "pi_legit_trace_a",
      amount: { amount: 1999, currency: "USD" },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("UNAUTHORIZED");
      expect(r.message).toContain("different Facet trace");
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("reserveAuthority rejects cross-site PI access before calling Stripe", async () => {
    const retrieve = vi.fn();
    const store = makeMemoryStore([
      {
        stripe_payment_intent_id: "pi_other_site",
        site_id: "site_OTHER",
        expected_amount_minor: 100,
        expected_currency: "USD",
        facet_trace_id: "trace_other",
      },
    ]);
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { retrieve } }),
      paymentIntentStore: store,
    });
    const r = await adapter.reserveAuthority({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_other_site",
      amount: { amount: 100, currency: "USD" },
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("UNAUTHORIZED");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("refund of a pi_-prefixed settlement_id from a different site is blocked", async () => {
    const create = vi.fn();
    const store = makeMemoryStore([
      {
        stripe_payment_intent_id: "pi_other_site",
        site_id: "site_OTHER",
        expected_amount_minor: 500,
        expected_currency: "USD",
        facet_trace_id: "trace_other",
      },
    ]);
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ refunds: { create } }),
      paymentIntentStore: store,
    });
    const r = await adapter.refund({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "pi_other_site",
      amount: { amount: 250, currency: "USD" },
      reason: "requested_by_customer",
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("UNAUTHORIZED");
    expect(create).not.toHaveBeenCalled();
  });

  it("refund of a ch_-prefixed settlement_id is NOT cross-checked (charge ids aren't tracked)", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "re_test_ok", created: 1748000000, charge: "ch_test" });
    const store = makeMemoryStore();
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ refunds: { create } }),
      paymentIntentStore: store,
    });
    const r = await adapter.refund({
      ctx,
      merchant_config: merchantConfig,
      settlement_id: "ch_test",
      amount: { amount: 100, currency: "USD" },
      reason: "requested_by_customer",
    });
    expect(r.kind).toBe("ok");
    expect(create).toHaveBeenCalledOnce();
  });

  it("backfills the store on first follow-up to an un-tracked PI (back-compat)", async () => {
    // Simulates a PI that predates the cross-check migration — the store has
    // no row, so capture treats this as a bootstrap and writes one
    // rather than rejecting.
    const capture = vi
      .fn()
      .mockResolvedValue({ id: "pi_legacy", status: "succeeded", latest_charge: "ch_x" });
    const store = makeMemoryStore();
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
      paymentIntentStore: store,
    });
    const r = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_legacy",
      amount: { amount: 500, currency: "USD" },
    });
    expect(r.kind).toBe("ok");
    expect(store.rows.get("pi_legacy")).toEqual({
      stripe_payment_intent_id: "pi_legacy",
      site_id: "site_test",
      expected_amount_minor: 500,
      expected_currency: "USD",
      facet_trace_id: "trace_test",
    });
  });

  it("when paymentIntentStore is unwired, the adapter passes through unchanged (back-compat)", async () => {
    const capture = vi
      .fn()
      .mockResolvedValue({ id: "pi_x", status: "succeeded", latest_charge: "ch_x" });
    const adapter = new StripeAdapter({
      stripe: makeStubStripe({ paymentIntents: { capture } }),
      // no paymentIntentStore
    });
    const r = await adapter.capture({
      ctx,
      merchant_config: merchantConfig,
      authority_handle: "pi_x",
      amount: { amount: 100, currency: "USD" },
    });
    expect(r.kind).toBe("ok");
    expect(capture).toHaveBeenCalledOnce();
  });
});
