// Deposit-mode primitives tests. These cover the two seams the venue's money
// safety rests on: the PI-create params (right mode/network/currency, the fee
// emission rules, and the ABSENCE of transfer_data.destination that keeps the
// flow non-custodial) and the deposit-address extractor (a wrong or missing
// shape returns null, never a bad address an agent would pay to).

import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  buildDepositPaymentIntentParams,
  DEPOSIT_NETWORK,
  DEPOSIT_TOKEN,
  extractBaseDepositAddress,
  makeDepositStripeClient,
  provisionDepositAddress,
  STRIPE_DEPOSIT_API_VERSION,
  type CryptoDepositPaymentMethodOptions,
} from "../src/deposit-mode.ts";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const META = { facet_trace_id: "t1", facet_site_id: "s1" };

describe("constants pin the preview API and Base-only scope", () => {
  it("pins the deposit-mode preview API version", () => {
    expect(STRIPE_DEPOSIT_API_VERSION).toBe("2026-03-25.preview");
  });
  it("scopes to base USDC", () => {
    expect(DEPOSIT_NETWORK).toBe("base");
    expect(DEPOSIT_TOKEN).toBe("usdc");
  });
});

describe("makeDepositStripeClient", () => {
  it("returns the injected client verbatim (no network construction in tests)", () => {
    const fake = { sentinel: true } as unknown as Stripe;
    expect(makeDepositStripeClient("sk_test_x", fake)).toBe(fake);
  });
});

describe("buildDepositPaymentIntentParams", () => {
  function cryptoOf(p: Stripe.PaymentIntentCreateParams): CryptoDepositPaymentMethodOptions {
    return p.payment_method_options as unknown as CryptoDepositPaymentMethodOptions;
  }

  it("sets deposit mode on the base network with USD crypto method", () => {
    const p = buildDepositPaymentIntentParams({
      amountMinor: 1225,
      metadata: META,
      onConnectedAccount: true,
      applicationFeeMinor: 18,
    });
    expect(p.amount).toBe(1225);
    expect(p.currency).toBe("usd");
    expect(p.payment_method_types).toEqual(["crypto"]);
    expect(p.confirm).toBe(true);
    const crypto = cryptoOf(p);
    expect(crypto.crypto.mode).toBe("deposit");
    expect(crypto.crypto.deposit_options.networks).toEqual([DEPOSIT_NETWORK]);
  });

  it("emits application_fee_amount ONLY on a connected account with a fee", () => {
    const withFee = buildDepositPaymentIntentParams({
      amountMinor: 1000,
      metadata: META,
      onConnectedAccount: true,
      applicationFeeMinor: 15,
    });
    expect(withFee.application_fee_amount).toBe(15);

    // Not on a connected account: no fee even if an amount is passed (the
    // platform account never charges itself a fee).
    const noConnect = buildDepositPaymentIntentParams({
      amountMinor: 1000,
      metadata: META,
      onConnectedAccount: false,
      applicationFeeMinor: 15,
    });
    expect(noConnect.application_fee_amount).toBeUndefined();

    // Connected but no fee configured: nothing to attach.
    const noFee = buildDepositPaymentIntentParams({
      amountMinor: 1000,
      metadata: META,
      onConnectedAccount: true,
    });
    expect(noFee.application_fee_amount).toBeUndefined();

    // A zero fee OMITS the field (matches the card rail's feeRate>0 gate), rather
    // than sending application_fee_amount: 0.
    const zeroFee = buildDepositPaymentIntentParams({
      amountMinor: 1000,
      metadata: META,
      onConnectedAccount: true,
      applicationFeeMinor: 0,
    });
    expect(zeroFee.application_fee_amount).toBeUndefined();
  });

  it("NEVER sets transfer_data.destination (the non-custodial invariant)", () => {
    const p = buildDepositPaymentIntentParams({
      amountMinor: 5000,
      metadata: META,
      onConnectedAccount: true,
      applicationFeeMinor: 75,
    });
    expect(p.transfer_data).toBeUndefined();
  });

  it("passes the Facet identity metadata through", () => {
    const p = buildDepositPaymentIntentParams({
      amountMinor: 100,
      metadata: META,
      onConnectedAccount: true,
      applicationFeeMinor: 1,
    });
    expect(p.metadata).toEqual(META);
  });
});

describe("extractBaseDepositAddress", () => {
  // The documented next_action.crypto_display_details response slice.
  function piWith(depositAddresses: Record<string, unknown>): Stripe.PaymentIntent {
    return {
      id: "pi_1",
      status: "requires_action",
      next_action: {
        type: "crypto_display_details",
        crypto_display_details: { deposit_addresses: depositAddresses },
      },
    } as unknown as Stripe.PaymentIntent;
  }

  it("reads the Base address and its USDC token contract", () => {
    const pi = piWith({
      base: {
        address: "0xbase_addr",
        supported_tokens: [{ token_currency: "usdc", token_contract_address: BASE_USDC }],
      },
    });
    expect(extractBaseDepositAddress(pi)).toEqual({
      address: "0xbase_addr",
      tokenContract: BASE_USDC,
    });
  });

  it("refuses (null) when supported_tokens is absent: cannot confirm the token, fail closed", () => {
    const pi = piWith({ base: { address: "0xbase_addr" } });
    expect(extractBaseDepositAddress(pi)).toBeNull();
  });

  it("refuses (null) a Base entry whose USDC contract is not the pinned one (stranded-funds guard)", () => {
    const wrong = piWith({
      base: {
        address: "0xbase_addr",
        supported_tokens: [
          {
            token_currency: "usdc",
            token_contract_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          },
        ],
      },
    });
    expect(extractBaseDepositAddress(wrong)).toBeNull();
  });

  it("matches the pinned contract case-insensitively", () => {
    const pi = piWith({
      base: {
        address: "0xbase_addr",
        supported_tokens: [
          { token_currency: "USDC", token_contract_address: BASE_USDC.toUpperCase() },
        ],
      },
    });
    expect(extractBaseDepositAddress(pi)?.address).toBe("0xbase_addr");
  });

  it("returns null when there is no base entry (wrong-network guard)", () => {
    const pi = piWith({ tempo: { address: "0xtempo" }, solana: { address: "sol" } });
    expect(extractBaseDepositAddress(pi)).toBeNull();
  });

  it("returns null on an empty or missing address", () => {
    expect(extractBaseDepositAddress(piWith({ base: { address: "" } }))).toBeNull();
    expect(extractBaseDepositAddress(piWith({ base: {} }))).toBeNull();
  });

  it("returns null when next_action or crypto_display_details is absent", () => {
    const noAction = {
      id: "pi",
      status: "requires_action",
      next_action: null,
    } as Stripe.PaymentIntent;
    expect(extractBaseDepositAddress(noAction)).toBeNull();
    const noDetails = {
      id: "pi",
      status: "requires_action",
      next_action: { type: "redirect_to_url" },
    } as unknown as Stripe.PaymentIntent;
    expect(extractBaseDepositAddress(noDetails)).toBeNull();
  });
});

describe("provisionDepositAddress", () => {
  const CONNECT = "acct_merchant";
  const BASE_PI = {
    id: "pi_dep_1",
    status: "requires_action",
    next_action: {
      type: "crypto_display_details",
      crypto_display_details: {
        deposit_addresses: {
          base: {
            address: "0xdeposit_addr",
            supported_tokens: [{ token_currency: "usdc", token_contract_address: BASE_USDC }],
          },
        },
      },
    },
  } as unknown as Stripe.PaymentIntent;

  function fakeStripe(
    create: (params: unknown, opts: unknown) => Promise<Stripe.PaymentIntent>,
  ): Stripe {
    return { paymentIntents: { create } } as unknown as Stripe;
  }

  it("creates the PI ON the connected account with the session idempotency key and returns the address", async () => {
    let seenOpts: unknown;
    const stripe = fakeStripe((_params, opts) => {
      seenOpts = opts;
      return Promise.resolve(BASE_PI);
    });
    const res = await provisionDepositAddress({
      stripe,
      connectAccountId: CONNECT,
      idempotencyKey: "sess_42",
      input: {
        amountMinor: 1225,
        metadata: META,
        onConnectedAccount: true,
        applicationFeeMinor: 18,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.paymentIntentId).toBe("pi_dep_1");
      expect(res.value.address).toBe("0xdeposit_addr");
      expect(res.value.tokenContract).toBe(BASE_USDC);
      expect(res.value.expiresAt).toBeNull(); // V4: unverified window
    }
    expect(seenOpts).toEqual({ idempotencyKey: "sess_42", stripeAccount: CONNECT });
  });

  it("FORCES the platform fee even if the caller passes onConnectedAccount:false", async () => {
    let seenParams: Stripe.PaymentIntentCreateParams | undefined;
    const stripe = fakeStripe((params, _opts) => {
      seenParams = params as Stripe.PaymentIntentCreateParams;
      return Promise.resolve(BASE_PI);
    });
    await provisionDepositAddress({
      stripe,
      connectAccountId: CONNECT,
      idempotencyKey: "sess_1",
      // The caller wrongly says false; the provisioner always runs on a connected
      // account, so the fee must still attach.
      input: {
        amountMinor: 1000,
        metadata: META,
        onConnectedAccount: false,
        applicationFeeMinor: 15,
      },
    });
    expect(seenParams?.application_fee_amount).toBe(15);
  });

  it("fails closed (not retryable) with no connected account, never calling Stripe", async () => {
    let called = false;
    const stripe = fakeStripe(() => {
      called = true;
      return Promise.resolve(BASE_PI);
    });
    const res = await provisionDepositAddress({
      stripe,
      connectAccountId: "  ",
      idempotencyKey: "s",
      input: { amountMinor: 100, metadata: META, onConnectedAccount: true, applicationFeeMinor: 5 },
    });
    expect(res).toEqual({
      ok: false,
      reason: "deposit venue requires a connected account id",
      retryable: false,
    });
    expect(called).toBe(false);
  });

  it("fails closed (not retryable) when Stripe returns no Base address", async () => {
    const noAddr = {
      id: "pi_x",
      status: "requires_payment_method",
      next_action: null,
    } as Stripe.PaymentIntent;
    const stripe = fakeStripe(() => Promise.resolve(noAddr));
    const res = await provisionDepositAddress({
      stripe,
      connectAccountId: CONNECT,
      idempotencyKey: "s",
      input: { amountMinor: 100, metadata: META, onConnectedAccount: true, applicationFeeMinor: 5 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retryable).toBe(false);
  });

  it("marks a transient Stripe error retryable and a definitive one not", async () => {
    const transient = fakeStripe(() =>
      Promise.reject(new Stripe.errors.StripeConnectionError({ message: "net" })),
    );
    const rt = await provisionDepositAddress({
      stripe: transient,
      connectAccountId: CONNECT,
      idempotencyKey: "s",
      input: { amountMinor: 100, metadata: META, onConnectedAccount: true, applicationFeeMinor: 5 },
    });
    expect(rt.ok).toBe(false);
    if (!rt.ok) expect(rt.retryable).toBe(true);

    const definitive = fakeStripe(() => Promise.reject(new Error("bad request")));
    const df = await provisionDepositAddress({
      stripe: definitive,
      connectAccountId: CONNECT,
      idempotencyKey: "s",
      input: { amountMinor: 100, metadata: META, onConnectedAccount: true, applicationFeeMinor: 5 },
    });
    expect(df.ok).toBe(false);
    if (!df.ok) expect(df.retryable).toBe(false);
  });

  it("fails closed (not retryable) on a missing or invalid fee, never calling Stripe", async () => {
    // A caller that omits the fee must NOT silently mint a fee-less (zero-revenue)
    // deposit. 0 is allowed (deliberate no-fee); absent, non-integer, or negative
    // is refused before any Stripe call.
    for (const bad of [undefined, 1.5, -1] as const) {
      let called = false;
      const stripe = fakeStripe(() => {
        called = true;
        return Promise.resolve(BASE_PI);
      });
      const res = await provisionDepositAddress({
        stripe,
        connectAccountId: CONNECT,
        idempotencyKey: "s",
        input: {
          amountMinor: 100,
          metadata: META,
          onConnectedAccount: true,
          ...(bad === undefined ? {} : { applicationFeeMinor: bad }),
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.retryable).toBe(false);
      expect(called).toBe(false);
    }

    // 0 is a deliberate no-fee and is accepted (reaches Stripe).
    let reached = false;
    const okStripe = fakeStripe(() => {
      reached = true;
      return Promise.resolve(BASE_PI);
    });
    const zero = await provisionDepositAddress({
      stripe: okStripe,
      connectAccountId: CONNECT,
      idempotencyKey: "s",
      input: { amountMinor: 100, metadata: META, onConnectedAccount: true, applicationFeeMinor: 0 },
    });
    expect(zero.ok).toBe(true);
    expect(reached).toBe(true);
  });
});
