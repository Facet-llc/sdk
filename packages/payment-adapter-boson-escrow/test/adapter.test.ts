import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CaptureInput,
  DisputeInput,
  MerchantConfig,
  RailRequestContext,
  ReserveAuthorityInput,
  VerifyAuthorityInput,
  WebhookRequest,
} from "@facet-llc/protocol";
import type { EscrowPaymentRequirements } from "@bosonprotocol/x402-core/schemes/escrow";

// ─── SDK mock — keep decodeXPaymentHeader + mapAsStore real, stub the
// network-touching surface (validatePaymentPayload + the server handlers).
const h = vi.hoisted(() => ({
  validateFn: vi.fn(),
  commitFn: vi.fn(),
  redeemFn: vi.fn(),
  disputeRaiseFn: vi.fn(),
  disputeResolveFn: vi.fn(),
  disputeRetractFn: vi.fn(),
  disputeEscalateFn: vi.fn(),
}));

vi.mock("@bosonprotocol/x402-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bosonprotocol/x402-server")>();
  return {
    ...actual,
    validatePaymentPayload: h.validateFn,
    createX402bServer: () => ({
      handlers: {
        commit: h.commitFn,
        redeem: h.redeemFn,
        disputeRaise: h.disputeRaiseFn,
        disputeResolve: h.disputeResolveFn,
        disputeRetract: h.disputeRetractFn,
        disputeEscalate: h.disputeEscalateFn,
      },
    }),
  };
});

import { createHmac } from "node:crypto";

import {
  BosonEscrowAdapter,
  type BosonMerchantConfig,
  type WebhookRejection,
} from "../src/adapter.ts";

/** HMAC-SHA256 hex over `body` with `secret` — mirrors the signing scheme
 *  the adapter verifies (plain-hex form). */
function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x7de418a7ce94debd057c34ebac232e7027634ade";
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const FACILITATOR = "https://facilitator.example.test";
const RPC = "https://base-sepolia-rpc.publicnode.com";
const HEX32 = "0x" + "ab".repeat(32);

function signer() {
  return { address: SELLER, signTypedData: vi.fn(async () => HEX32 as `0x${string}`) };
}

function merchantConfig(over: Partial<Record<string, unknown>> = {}): MerchantConfig {
  return {
    network: "eip155:84532",
    chainId: 84532,
    escrow: ESCROW,
    sellerId: "42",
    disputeResolverId: "1",
    asset: ASSET,
    facilitatorUrl: FACILITATOR,
    signer: signer(),
    ...over,
  };
}

function requirements(over: Partial<EscrowPaymentRequirements> = {}): EscrowPaymentRequirements {
  return {
    scheme: "escrow",
    network: "eip155:84532",
    asset: ASSET,
    amount: "1230000",
    escrowAddress: ESCROW,
    recipientId: "42",
    maxTimeoutSeconds: 3600,
    offer: { fullOffer: { price: "1230000" }, sellerSig: HEX32, creator: SELLER },
    tokenAuthStrategies: ["none"],
    actions: { next: [{ id: "boson-createOfferAndCommit", channels: ["facilitator"] }] },
    ...over,
  } as EscrowPaymentRequirements;
}

/** A structurally-valid escrow X-PAYMENT (real decodeXPaymentHeader parses
 *  it; sig verification is validatePaymentPayload's job, which we mock). */
function xPaymentHeader(action = "boson-createOfferAndCommit"): string {
  const payload = {
    x402Version: 1,
    scheme: "escrow",
    network: "eip155:84532",
    payload: {
      action,
      tokenAuthStrategy: "none",
      offerRef: { fullOffer: { price: "1230000" }, sellerSig: HEX32 },
      buyer: BUYER,
      metaTx: {
        from: BUYER,
        nonce: "1",
        functionName: "executeMetaTransaction",
        functionSignature: "0xdeadbeef",
        sig: { v: 27, r: HEX32, s: HEX32 },
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function ctx(): RailRequestContext {
  return {
    trace_id: "trace_1",
    idempotency_key: "idem_1",
    merchant_id: "m1",
    site_id: "11111111-1111-1111-1111-111111111111",
    received_at: new Date().toISOString(),
  };
}

function makeAdapter() {
  return new BosonEscrowAdapter({
    facilitatorUrl: FACILITATOR,
    rpcUrl: RPC,
    exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => null }),
    mode: "development",
    now: () => Date.parse("2026-06-02T00:00:00.000Z"),
  });
}

/** Build an exchange snapshot stub for the on-chain ExchangeReader. Only
 *  `price` (atomic escrowed amount) is load-bearing for the capture
 *  amount-binding gate; the rest satisfy the ExchangeSnapshot shape. */
function snapshot(price: string) {
  return { state: "Committed", seller: SELLER, exchangeToken: ASSET, price } as unknown as Awaited<
    ReturnType<import("@bosonprotocol/x402-server").ExchangeReader["read"]>
  >;
}

/** Adapter whose on-chain reader returns a fixed escrowed price, so the
 *  capture amount-binding gate has a real value to compare against. */
function makeAdapterWithEscrowedPrice(price: string) {
  return new BosonEscrowAdapter({
    facilitatorUrl: FACILITATOR,
    rpcUrl: RPC,
    exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => snapshot(price) }),
    mode: "development",
    now: () => Date.parse("2026-06-02T00:00:00.000Z"),
  });
}

const USDC = (amount: number) => ({ amount, currency: "USDC" });

beforeEach(() => {
  vi.clearAllMocks();
  h.validateFn.mockResolvedValue({ ok: true });
});

// ─── metadata ────────────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.metadata", () => {
  it("declares the coin/boson-escrow rail with the two-step + dispute flags", () => {
    const a = makeAdapter();
    expect(a.metadata.id).toBe("coin/boson-escrow");
    expect(a.metadata.supports_reserve_capture).toBe(true);
    expect(a.metadata.supports_dispute).toBe(true);
    expect(a.metadata.currencies).toEqual(["USDC"]);
  });

  it("declares a minimal egress allowlist of just the facilitator + RPC origins", () => {
    const a = makeAdapter();
    expect(a.metadata.egress_allowlist).toContain(new URL(FACILITATOR).origin);
    expect(a.metadata.egress_allowlist).toContain(new URL(RPC).origin);
    expect(a.metadata.egress_allowlist.length).toBe(2);
  });
});

// ─── verifyAuthority ──────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.verifyAuthority", () => {
  const base = (): VerifyAuthorityInput => ({
    ctx: ctx(),
    merchant_config: merchantConfig(),
    authority: { x_payment: xPaymentHeader(), requirements: requirements() },
    amount: USDC(1230000),
  });

  it("returns ok and a re-decodable handle for a valid commit authority", async () => {
    const res = await makeAdapter().verifyAuthority(base());
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.authority_handle.startsWith("bosonv1:")).toBe(true);
    expect(res.value.expires_at).not.toBeNull();
    // validatePaymentPayload was consulted with our chainId.
    expect(h.validateFn).toHaveBeenCalledTimes(1);
    expect(h.validateFn.mock.calls[0]?.[0]).toMatchObject({ chainId: 84532 });
  });

  it("rejects a non-USDC currency", async () => {
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      amount: { amount: 100, currency: "EUR" },
    });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("rejects a missing x_payment", async () => {
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      authority: { requirements: requirements() },
    });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("rejects an offer not signed by this merchant's seller (self-dealing gate)", async () => {
    const evil = requirements({
      offer: { fullOffer: { price: "1230000" }, sellerSig: HEX32, creator: BUYER },
    });
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      authority: { x_payment: xPaymentHeader(), requirements: evil },
    });
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "offer_creator_mismatch",
    });
  });

  it("rejects an amount that does not match the signed requirements", async () => {
    const res = await makeAdapter().verifyAuthority({ ...base(), amount: USDC(9999999) });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("rejects a Flow B (atomic commit+redeem) action — two-step only", async () => {
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      authority: {
        x_payment: xPaymentHeader("boson-createOfferCommitAndRedeem"),
        requirements: requirements(),
      },
    });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("surfaces a validatePaymentPayload failure as UNAUTHORIZED", async () => {
    h.validateFn.mockResolvedValue({ ok: false, rule: 7, code: "SELLER_SIG_MISMATCH" });
    const res = await makeAdapter().verifyAuthority(base());
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "SELLER_SIG_MISMATCH",
    });
  });

  // ─── EIP-712 domain + nonce-replay binding ───────────────────────────────────
  // The escrow Diamond is the EIP-712 verifyingContract; the adapter must bind
  // the buyer-echoed requirements to OUR domain and must fail closed when the
  // validator reports a reused authorization nonce.

  it("rejects a mismatched EIP-712 verifyingContract (escrow Diamond)", async () => {
    const wrongDomain = requirements({
      escrowAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      authority: { x_payment: xPaymentHeader(), requirements: wrongDomain },
    });
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_mismatch",
    });
  });

  it("rejects a mismatched EIP-712 network (chain domain)", async () => {
    const wrongChain = requirements({ network: "eip155:8453" });
    const res = await makeAdapter().verifyAuthority({
      ...base(),
      authority: { x_payment: xPaymentHeader(), requirements: wrongChain },
    });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("fails closed when validatePaymentPayload reports a reused nonce (replay)", async () => {
    h.validateFn.mockResolvedValue({
      ok: false,
      rule: "erc3009-nonce",
      code: "NONCE_ALREADY_USED",
    });
    const res = await makeAdapter().verifyAuthority(base());
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "NONCE_ALREADY_USED",
    });
  });
});

// ─── reserveAuthority (commit) ────────────────────────────────────────────────

describe("BosonEscrowAdapter.reserveAuthority", () => {
  async function handleFor(adapter = makeAdapter()): Promise<string> {
    const v = await adapter.verifyAuthority({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority: { x_payment: xPaymentHeader(), requirements: requirements() },
      amount: USDC(1230000),
    });
    if (v.kind !== "ok") throw new Error("verify failed");
    return v.value.authority_handle;
  }

  it("commits the escrow and surfaces COMMITTED escrow_state + the redeem deadline", async () => {
    h.commitFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        exchangeId: "7",
        txHash: "0xcommit",
        nextActions: {
          exchangeId: "7",
          exchangeState: "COMMITTED",
          next: [
            { id: "boson-redeem", channels: ["facilitator"], deadline: "2026-07-01T00:00:00.000Z" },
          ],
        },
      },
    });
    const adapter = makeAdapter();
    const input: ReserveAuthorityInput = {
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority_handle: await handleFor(adapter),
      amount: USDC(1230000),
    };
    const res = await adapter.reserveAuthority(input);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.reservation_active).toBe(true);
    expect(res.value.reserved_until).toBe("2026-07-01T00:00:00.000Z");
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({
      exchange_id: "7",
      exchange_state: "COMMITTED",
    });
    expect(res.value.rail_metadata?.tx_hash).toBe("0xcommit");
    // The commit handler saw the re-presented X-PAYMENT + requirements.
    expect(h.commitFn).toHaveBeenCalledTimes(1);
    expect(h.commitFn.mock.calls[0]?.[0]).toHaveProperty("paymentHeader");
    expect(h.commitFn.mock.calls[0]?.[0]).toHaveProperty("requirements");
  });

  it("rejects a handle that is not a Boson commit handle", async () => {
    const res = await makeAdapter().reserveAuthority({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority_handle: "not-a-boson-handle",
      amount: USDC(1230000),
    });
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("maps a 402 commit rejection to a non-retryable SETTLEMENT_FAILED", async () => {
    h.commitFn.mockResolvedValue({
      ok: false,
      status: 402,
      body: { code: "INSUFFICIENT_PAYMENT", reason: "token auth amount too low" },
    });
    const adapter = makeAdapter();
    const res = await adapter.reserveAuthority({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority_handle: await handleFor(adapter),
      amount: USDC(1230000),
    });
    expect(res).toMatchObject({
      kind: "error",
      code: "SETTLEMENT_FAILED",
      retryable: false,
      native_code: "INSUFFICIENT_PAYMENT",
    });
  });
});

// ─── capture (redeem) ─────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.capture", () => {
  const captureInput = (authority: Record<string, unknown>): CaptureInput => ({
    ctx: ctx(),
    merchant_config: merchantConfig(),
    authority_handle: "bosonv1:ignored",
    amount: USDC(1230000),
    authority,
  });

  it("redeems with the buyer's signed payload and returns exchangeId as settlement_id", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const res = await makeAdapter().capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.settlement_id).toBe("7");
    expect(res.value.rail_metadata?.tx_hash).toBe("0xredeem");
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({ exchange_state: "REDEEMED" });
    expect(h.redeemFn.mock.calls[0]?.[0]).toMatchObject({
      exchangeId: "7",
      signedPayload: "0xabababab",
    });
  });

  it("forwards a fulfillment selection to the redeem handler", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    await makeAdapter().capture(
      captureInput({
        exchange_id: "7",
        signed_payload: "0xabababab",
        fulfillment: { option: "webhook", data: { url: "https://buyer.example/cb" } },
      }),
    );
    expect(h.redeemFn.mock.calls[0]?.[0]).toMatchObject({
      fulfillment: { option: "webhook", data: { url: "https://buyer.example/cb" } },
    });
  });

  it("rejects a capture missing the redeem authorization", async () => {
    const res = await makeAdapter().capture(captureInput({ exchange_id: "7" }));
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("maps a 409 redeem rejection to SETTLEMENT_FAILED", async () => {
    h.redeemFn.mockResolvedValue({
      ok: false,
      status: 409,
      body: { code: "WRONG_STATE", reason: "exchange not COMMITTED" },
    });
    const res = await makeAdapter().capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "SETTLEMENT_FAILED",
      native_code: "WRONG_STATE",
    });
  });

  it("refuses to redeem when the escrowed amount is below the captured amount", async () => {
    // Attack: agent commits a ~$0 offer then redeems it against an expensive
    // reservation. The on-chain escrow price (1) must equal the captured
    // amount (1230000) — it does not, so capture fails closed and redeem is
    // never called.
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const res = await makeAdapterWithEscrowedPrice("1").capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_amount_mismatch",
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  it("redeems when the escrowed amount equals the captured amount", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const res = await makeAdapterWithEscrowedPrice("1230000").capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res.kind).toBe("ok");
    expect(h.redeemFn).toHaveBeenCalledTimes(1);
  });
});

// ─── refund ───────────────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.refund", () => {
  it("surfaces METHOD_NOT_ALLOWED until a seller action-signer is wired", async () => {
    const res = await makeAdapter().refund({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      settlement_id: "7",
      amount: USDC(1230000),
      reason: "buyer changed mind",
    });
    expect(res).toMatchObject({ kind: "error", code: "METHOD_NOT_ALLOWED" });
  });
});

// ─── dispute ──────────────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.dispute", () => {
  const disputeInput = (over: Partial<DisputeInput>): DisputeInput => ({
    ctx: ctx(),
    merchant_config: merchantConfig(),
    settlement_id: "7",
    action: "challenge",
    ...over,
  });

  it("raises a dispute on action=challenge", async () => {
    h.disputeRaiseFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xraise",
        nextActions: {
          exchangeId: "7",
          exchangeState: "DISPUTED",
          disputeState: "RESOLVING",
          next: [],
        },
      },
    });
    const res = await makeAdapter().dispute(
      disputeInput({ evidence: { signed_payload: "0xabababab" } }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toMatchObject({ dispute_id: "7", status: "open" });
    expect(h.disputeRaiseFn).toHaveBeenCalledTimes(1);
  });

  it("retracts on action=accept", async () => {
    h.disputeRetractFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xretract",
        nextActions: {
          exchangeId: "7",
          exchangeState: "DISPUTED",
          disputeState: "RETRACTED",
          next: [],
        },
      },
    });
    const res = await makeAdapter().dispute(
      disputeInput({ action: "accept", evidence: { signed_payload: "0xabababab" } }),
    );
    expect(res).toMatchObject({ kind: "ok" });
    expect(h.disputeRetractFn).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit boson_action override (escalate)", async () => {
    h.disputeEscalateFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xesc",
        nextActions: {
          exchangeId: "7",
          exchangeState: "DISPUTED",
          disputeState: "ESCALATED",
          next: [],
        },
      },
    });
    await makeAdapter().dispute(
      disputeInput({ evidence: { signed_payload: "0xabababab", boson_action: "escalate" } }),
    );
    expect(h.disputeEscalateFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a dispute missing the signed meta-tx", async () => {
    const res = await makeAdapter().dispute(disputeInput({ evidence: {} }));
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });
});

// ─── handleWebhook ────────────────────────────────────────────────────────────

describe("BosonEscrowAdapter.handleWebhook", () => {
  const webhook = (parsed: Record<string, unknown> | null): WebhookRequest => ({
    ctx: ctx(),
    merchant_config: merchantConfig(),
    raw_body: new Uint8Array(),
    parsed_body: parsed,
    headers: {},
  });

  it("maps a COMPLETED/RELEASED exchange to settlement_confirmed", async () => {
    const res = await makeAdapter().handleWebhook(
      webhook({
        exchangeId: "7",
        exchangeState: "COMPLETED",
        timestamp: "2026-06-10T00:00:00.000Z",
      }),
    );
    expect(res).toMatchObject({
      kind: "ok",
      value: {
        kind: "settlement_confirmed",
        settlement_id: "7",
        confirmed_at: "2026-06-10T00:00:00.000Z",
      },
    });
  });

  it("maps a DISPUTED exchange to dispute_opened", async () => {
    const res = await makeAdapter().handleWebhook(
      webhook({ exchangeId: "7", exchangeState: "DISPUTED" }),
    );
    expect(res).toMatchObject({ kind: "ok", value: { kind: "dispute_opened", dispute_id: "7" } });
  });

  it("maps a resolved dispute to dispute_resolved", async () => {
    const res = await makeAdapter().handleWebhook(
      webhook({ exchangeId: "7", exchangeState: "DISPUTED", disputeState: "RETRACTED" }),
    );
    expect(res).toMatchObject({
      kind: "ok",
      value: { kind: "dispute_resolved", resolution: "withdrawn" },
    });
  });

  it("ignores an unparsed or unrecognised body", async () => {
    expect(await makeAdapter().handleWebhook(webhook(null))).toMatchObject({
      value: { kind: "ignored" },
    });
    expect(await makeAdapter().handleWebhook(webhook({ foo: "bar" }))).toMatchObject({
      value: { kind: "ignored" },
    });
  });
});

// ─── handleWebhook signature verification ──────────────────────────────

describe("BosonEscrowAdapter.handleWebhook versioned secrets", () => {
  const CURRENT = "boson_whsec_current";
  const PREVIOUS = "boson_whsec_old";
  const bodyObj = { exchangeId: "7", exchangeState: "COMPLETED" };
  const bodyStr = JSON.stringify(bodyObj);
  const rawBody = new TextEncoder().encode(bodyStr);

  // Adapter wired with a webhook secret + a rejection-logger spy.
  function signedAdapter(over: Record<string, unknown> = {}) {
    const rejections: WebhookRejection[] = [];
    const adapter = new BosonEscrowAdapter({
      facilitatorUrl: FACILITATOR,
      rpcUrl: RPC,
      exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => null }),
      mode: "development",
      now: () => Date.parse("2026-06-02T00:00:00.000Z"),
      webhookRejectionLogger: (r) => rejections.push(r),
    });
    const cfg = merchantConfig({ webhook_secret: CURRENT, ...over });
    return { adapter, cfg, rejections };
  }

  function req(cfg: MerchantConfig, headers: Record<string, string>): WebhookRequest {
    return { ctx: ctx(), merchant_config: cfg, raw_body: rawBody, parsed_body: bodyObj, headers };
  }

  it("accepts a webhook signed with the current secret (x-boson-signature)", async () => {
    const { adapter, cfg, rejections } = signedAdapter();
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": hmacHex(CURRENT, bodyStr) }),
    );
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
    expect(rejections).toHaveLength(0);
  });

  it("accepts a sha256=-prefixed signature on the x-webhook-signature header", async () => {
    const { adapter, cfg } = signedAdapter();
    const res = await adapter.handleWebhook(
      req(cfg, { "x-webhook-signature": `sha256=${hmacHex(CURRENT, bodyStr)}` }),
    );
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
  });

  it("accepts a webhook still signed with the PREVIOUS secret during rotation", async () => {
    const { adapter, cfg, rejections } = signedAdapter({ webhook_secret_previous: PREVIOUS });
    // signed with the OLD secret — must still be accepted mid-rotation
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": hmacHex(PREVIOUS, bodyStr) }),
    );
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
    expect(rejections).toHaveLength(0);
  });

  it("accepts a Stripe-style t=,v1= signature over `${t}.${body}`", async () => {
    const { adapter, cfg } = signedAdapter();
    // `t` must be within the 300s tolerance of the adapter's mocked now
    // (2026-06-02T00:00:00Z) — use that exact second.
    const t = Math.floor(Date.parse("2026-06-02T00:00:00.000Z") / 1000);
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": `t=${t},v1=${hmacHex(CURRENT, `${t}.${bodyStr}`)}` }),
    );
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
  });

  it("rejects a t=,v1= signature whose timestamp is older than the 300s tolerance", async () => {
    const { adapter, cfg, rejections } = signedAdapter();
    // 301s before the adapter's mocked now — HMAC is valid, but the stale
    // timestamp must be rejected as a replay (Stripe-style ±300s tolerance).
    const t = Math.floor(Date.parse("2026-06-02T00:00:00.000Z") / 1000) - 301;
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": `t=${t},v1=${hmacHex(CURRENT, `${t}.${bodyStr}`)}` }),
    );
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: "signature_mismatch" });
  });

  it("rejects + logs (with trace id) a signature matching neither secret", async () => {
    const { adapter, cfg, rejections } = signedAdapter({ webhook_secret_previous: PREVIOUS });
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": hmacHex("boson_whsec_wrong", bodyStr) }),
    );
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      rail: "coin/boson-escrow",
      trace_id: "trace_1",
      reason: "signature_mismatch",
    });
  });

  it("rejects + logs when the signature header is missing but a secret is set", async () => {
    const { adapter, cfg, rejections } = signedAdapter();
    const res = await adapter.handleWebhook(req(cfg, {}));
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(rejections[0]).toMatchObject({
      reason: "missing_signature_header",
      trace_id: "trace_1",
    });
  });

  it("does not over-accept: an old-secret signature is rejected once PREVIOUS is dropped", async () => {
    // only the current secret is configured (rotation complete)
    const { adapter, cfg, rejections } = signedAdapter();
    const res = await adapter.handleWebhook(
      req(cfg, { "x-boson-signature": hmacHex(PREVIOUS, bodyStr) }),
    );
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(rejections).toHaveLength(1);
  });

  it("trusts the parsed body when NO webhook secret is configured (back-compat)", async () => {
    // no webhook_secret in merchant_config → verification skipped entirely,
    // even with no signature header (the host verifies at its own route)
    const res = await makeAdapter().handleWebhook({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      raw_body: rawBody,
      parsed_body: bodyObj,
      headers: {},
    });
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
  });

  it("settles with an EMPTY merchant_config (the exact shape the live handler passes)", async () => {
    // REGRESSION GUARD: the live host-server handler verifies the signature at
    // its own /v1/boson/webhook route, then delegates with merchant_config: {}.
    // handleWebhook must NOT read/enforce the merchant_config when no secret is
    // in play — doing so 4xx'd every inbound Boson settlement webhook and orders
    // never settled via the webhook path.
    const res = await makeAdapter().handleWebhook({
      ctx: ctx(),
      merchant_config: {},
      raw_body: rawBody,
      parsed_body: bodyObj,
      headers: {},
    });
    expect(res).toMatchObject({
      kind: "ok",
      value: { kind: "settlement_confirmed", settlement_id: "7" },
    });
  });
});

// ─── full two-step lifecycle ──────────────────────────────────────────────────

describe("BosonEscrowAdapter lifecycle: verify → reserve → capture", () => {
  it("threads the verify handle into commit and the commit exchangeId into redeem", async () => {
    h.commitFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        exchangeId: "7",
        txHash: "0xcommit",
        nextActions: { exchangeId: "7", exchangeState: "COMMITTED", next: [] },
      },
    });
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const adapter = makeAdapter();

    const verified = await adapter.verifyAuthority({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority: { x_payment: xPaymentHeader(), requirements: requirements() },
      amount: USDC(1230000),
    });
    expect(verified.kind).toBe("ok");
    if (verified.kind !== "ok") return;

    const reserved = await adapter.reserveAuthority({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority_handle: verified.value.authority_handle,
      amount: USDC(1230000),
    });
    expect(reserved.kind).toBe("ok");
    if (reserved.kind !== "ok") return;
    const exchangeId = (reserved.value.rail_metadata?.escrow_state as { exchange_id: string })
      .exchange_id;
    expect(exchangeId).toBe("7");

    const captured = await adapter.capture({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      authority_handle: verified.value.authority_handle,
      amount: USDC(1230000),
      authority: { exchange_id: exchangeId, signed_payload: "0xabababab" },
    });
    expect(captured.kind).toBe("ok");
    if (captured.kind !== "ok") return;
    expect(captured.value.settlement_id).toBe("7");
  });
});
