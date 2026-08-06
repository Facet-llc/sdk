import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CaptureInput,
  DisputeInput,
  MerchantConfig,
  RailRequestContext,
  RefundInput,
  ReserveAuthorityInput,
  VerifyAuthorityInput,
  WebhookRequest,
} from "@facet-llc/adapter";
import type { EscrowPaymentRequirements } from "@bosonprotocol/x402-core/schemes/escrow";
import { metaTransactionExchangeTypedData } from "@bosonprotocol/x402-core/eip712";
import { encodeSignedPayload } from "@bosonprotocol/x402-evm/codec";
import { encodeFunctionData, type Hex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
  performActionFn: vi.fn(),
}));

vi.mock("@bosonprotocol/x402-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bosonprotocol/x402-server")>();
  return {
    ...actual,
    validatePaymentPayload: h.validateFn,
    createX402bServer: () => ({
      // The FacilitatorClient the adapter's refund() relays cancel through directly
      // (x402-server exposes no cancel handler).
      facilitator: { performAction: h.performActionFn },
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
import { BosonBindingMismatchError } from "../src/binding-error.ts";

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
    // Model the Facet host: it verifies the webhook signature at its own route
    // and delegates already-verified, so the adapter runs its lenient path.
    requireWebhookSignature: false,
  });
}

/** Build an exchange snapshot stub for the on-chain ExchangeReader. `price`
 *  (atomic escrowed amount), `seller`, and `exchangeToken` are the fields the
 *  capture binding gate compares; they default to this merchant's values so a
 *  matching snapshot redeems cleanly, and `over` lets a test inject a mismatch. */
function snapshot(
  price: string,
  over: { seller?: string; exchangeToken?: string; state?: string; disputeState?: string } = {},
) {
  return {
    state: over.state ?? "Committed",
    ...(over.disputeState !== undefined ? { disputeState: over.disputeState } : {}),
    seller: over.seller ?? SELLER,
    exchangeToken: over.exchangeToken ?? ASSET,
    price,
  } as unknown as Awaited<ReturnType<import("@bosonprotocol/x402-server").ExchangeReader["read"]>>;
}

/** Adapter whose reader returns `snap` but whose clock JUMPS past the reverify
 *  budget on its second read — so a non-matching snapshot gives up on the first
 *  deadline check with NO real sleep (deterministic reverify-timeout test). */
function makeAdapterReturningWithExpiredBudget(snap: ReturnType<typeof snapshot>) {
  let t = Date.parse("2026-06-02T00:00:00.000Z");
  return new BosonEscrowAdapter({
    facilitatorUrl: FACILITATOR,
    rpcUrl: RPC,
    exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => snap }),
    mode: "development",
    now: () => {
      const v = t;
      t += 60_000; // > REVERIFY_BUDGET_MS, so the deadline check trips immediately
      return v;
    },
  });
}

/** Adapter whose on-chain reader returns the given snapshot, so the capture
 *  binding gate has real seller/token/price values to compare against. */
function makeAdapterReturning(snap: ReturnType<typeof snapshot>) {
  return new BosonEscrowAdapter({
    facilitatorUrl: FACILITATOR,
    rpcUrl: RPC,
    exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => snap }),
    mode: "development",
    now: () => Date.parse("2026-06-02T00:00:00.000Z"),
  });
}

/** Adapter whose on-chain reader THROWS on read — mirrors the host's production
 *  reader, which asserts the merchant binding and throws (BosonBindingMismatchError
 *  on a seller/asset mismatch, a plain Error on a transient RPC failure). */
function makeAdapterWithThrowingReader(err: unknown) {
  return new BosonEscrowAdapter({
    facilitatorUrl: FACILITATOR,
    rpcUrl: RPC,
    exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({
      read: async () => {
        throw err;
      },
    }),
    mode: "development",
    now: () => Date.parse("2026-06-02T00:00:00.000Z"),
  });
}

/** Adapter whose on-chain reader returns a fixed escrowed price (seller/token
 *  matched to this merchant), so the capture price gate has a value to bind. */
function makeAdapterWithEscrowedPrice(price: string) {
  return makeAdapterReturning(snapshot(price));
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

  it("refuses to redeem a voucher whose on-chain seller is not this merchant's signer", async () => {
    // x402B #115 review: the buyer owns a voucher (valid on-chain) that
    // was committed against ANOTHER seller's offer and asks this server to relay
    // its redeem. Price happens to match; seller does not — fail closed.
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const otherSeller = "0x9999999999999999999999999999999999999999";
    const res = await makeAdapterReturning(snapshot("1230000", { seller: otherSeller })).capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_seller_mismatch",
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  it("refuses to redeem when the escrowed token is not the merchant asset", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const otherToken = "0x8888888888888888888888888888888888888888";
    const res = await makeAdapterReturning(
      snapshot("1230000", { exchangeToken: otherToken }),
    ).capture(captureInput({ exchange_id: "7", signed_payload: "0xabababab" }));
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_token_mismatch",
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  // Boson DD review (2026-07-06): the deferred-redeem path holds a buyer's
  // pre-signed redeem and fires it later at fulfillment. If the exchange moved
  // OFF Committed in the interim (buyer cancelled / seller revoked / window
  // elapsed), seller+token+price all still match (they don't change on cancel),
  // so ONLY the state gate can refuse. Fail closed locally instead of relaying a
  // redeem the Diamond would revert.
  it("refuses to redeem a voucher whose on-chain state is no longer Committed", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    for (const state of ["Cancelled", "Revoked", "Redeemed", "Completed", "Disputed"]) {
      const res = await makeAdapterReturning(snapshot("1230000", { state })).capture(
        captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
      );
      expect(res).toMatchObject({
        kind: "error",
        code: "UNAUTHORIZED",
        native_code: "escrow_state_not_committed",
        retryable: false,
      });
    }
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  // Fail-OPEN contract: an unreadable state (missing / non-string) must NOT block
  // a real redeem. The state gate fires only on a KNOWN non-Committed value,
  // mirroring the seller/token gates; here seller + token + price all match.
  it("redeems when the on-chain state is unreadable (fail open, not closed)", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const noStateSnap = {
      seller: SELLER,
      exchangeToken: ASSET,
      price: "1230000",
    } as unknown as Awaited<
      ReturnType<import("@bosonprotocol/x402-server").ExchangeReader["read"]>
    >;
    const res = await makeAdapterReturning(noStateSnap).capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res.kind).toBe("ok");
    expect(h.redeemFn).toHaveBeenCalledTimes(1);
  });

  // Production-path coverage (x402B #115 review): the host's real reader ASSERTS
  // the binding and THROWS on a mismatch, rather than returning a mismatching
  // snapshot. The gate must map that throw to a non-retryable UNAUTHORIZED — not
  // swallow it (fail-open, dead code) nor surface a retryable SETTLEMENT_FAILED.
  it("maps a reader's BosonBindingMismatchError(seller) to a non-retryable UNAUTHORIZED", async () => {
    const adapter = makeAdapterWithThrowingReader(
      new BosonBindingMismatchError("seller", SELLER, "0x9999999999999999999999999999999999999999"),
    );
    const res = await adapter.capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_seller_mismatch",
      retryable: false,
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  it("maps a reader's BosonBindingMismatchError(asset) to a non-retryable UNAUTHORIZED", async () => {
    const adapter = makeAdapterWithThrowingReader(
      new BosonBindingMismatchError("asset", ASSET, "0x8888888888888888888888888888888888888888"),
    );
    const res = await adapter.capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_token_mismatch",
      retryable: false,
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });

  it("fails OPEN (proceeds to redeem) when the reader throws a transient (non-binding) error", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    const adapter = makeAdapterWithThrowingReader(new Error("RPC timeout / not yet indexed"));
    const res = await adapter.capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res.kind).toBe("ok");
    expect(h.redeemFn).toHaveBeenCalledTimes(1);
  });

  // L1-UCP-BSN-002: the price-binding check must fail CLOSED, not OPEN. The reader
  // returns a snapshot whose seller + token match this merchant (so the seller and
  // token gates pass) but with NO price string. Without the fix the gate treats a
  // missing/non-string price as PASS and redeems against an unverifiable on-chain
  // amount; with the fix it returns a non-retryable UNAUTHORIZED (escrow_price_
  // unverifiable) and never calls redeem.
  it("refuses to redeem when the escrowed price is missing / not a string (fail closed)", async () => {
    h.redeemFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xredeem",
        nextActions: { exchangeId: "7", exchangeState: "REDEEMED", next: [] },
      },
    });
    // A snapshot with the right seller + token but no price field. seller/token
    // gates pass, so this isolates the price branch.
    const noPriceSnap = {
      state: "Committed",
      seller: SELLER,
      exchangeToken: ASSET,
    } as unknown as Awaited<
      ReturnType<import("@bosonprotocol/x402-server").ExchangeReader["read"]>
    >;
    const res = await makeAdapterReturning(noPriceSnap).capture(
      captureInput({ exchange_id: "7", signed_payload: "0xabababab" }),
    );
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "escrow_price_unverifiable",
      retryable: false,
    });
    expect(h.redeemFn).not.toHaveBeenCalled();
  });
});

// ─── refund ───────────────────────────────────────────────────────────────────

// A real buyer-signed exchange meta-tx (cancel or redeem), built with the same
// SDK primitives a live buyer's wallet uses — so refund() runs the REAL
// validateCancelPayload + assertExchangeBinding, and only the facilitator relay
// is mocked. chainId + verifyingContract match merchantConfig() so the signature
// recovers.
const CANCEL_BUYER = privateKeyToAccount(`0x${"33".repeat(32)}` as Hex);
const CANCEL_ABI = parseAbi(["function cancelVoucher(uint256 _exchangeId)"]);
const REDEEM_ABI_T = parseAbi(["function redeemVoucher(uint256 _exchangeId)"]);

async function buildExchangeMetaTx(
  functionName: string,
  calldata: Hex,
  exchangeId: bigint,
): Promise<string> {
  const typedData = await metaTransactionExchangeTypedData({
    chainId: 84532,
    verifyingContract: ESCROW as `0x${string}`,
    nonce: 9n,
    from: CANCEL_BUYER.address,
    functionName,
    exchangeId,
  });
  // deno-lint-ignore no-explicit-any
  const signature = await CANCEL_BUYER.signTypedData(typedData as any);
  return encodeSignedPayload({
    from: CANCEL_BUYER.address,
    nonce: "9",
    functionName,
    functionSignature: calldata,
    sig: {
      v: parseInt(signature.slice(130, 132), 16),
      r: signature.slice(0, 66) as Hex,
      s: `0x${signature.slice(66, 130)}` as Hex,
    },
  });
}
const cancelPayload = (exchangeId: bigint) =>
  buildExchangeMetaTx(
    "cancelVoucher(uint256)",
    encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancelVoucher", args: [exchangeId] }),
    exchangeId,
  );

// Real buyer-signed dispute meta-txs (raise/retract/escalate) — same
// MetaTxExchange struct family as cancel, so dispute() runs the REAL
// validateDisputePayload and only the SDK handler is mocked.
const RAISE_DISPUTE_ABI = parseAbi(["function raiseDispute(uint256 _exchangeId)"]);
const RETRACT_DISPUTE_ABI = parseAbi(["function retractDispute(uint256 _exchangeId)"]);
const ESCALATE_DISPUTE_ABI = parseAbi(["function escalateDispute(uint256 _exchangeId)"]);
const raiseDisputePayload = (exchangeId: bigint) =>
  buildExchangeMetaTx(
    "raiseDispute(uint256)",
    encodeFunctionData({
      abi: RAISE_DISPUTE_ABI,
      functionName: "raiseDispute",
      args: [exchangeId],
    }),
    exchangeId,
  );
const retractDisputePayload = (exchangeId: bigint) =>
  buildExchangeMetaTx(
    "retractDispute(uint256)",
    encodeFunctionData({
      abi: RETRACT_DISPUTE_ABI,
      functionName: "retractDispute",
      args: [exchangeId],
    }),
    exchangeId,
  );
const escalateDisputePayload = (exchangeId: bigint) =>
  buildExchangeMetaTx(
    "escalateDispute(uint256)",
    encodeFunctionData({
      abi: ESCALATE_DISPUTE_ABI,
      functionName: "escalateDispute",
      args: [exchangeId],
    }),
    exchangeId,
  );

describe("BosonEscrowAdapter.refund (pre-redeem buyer-cancel)", () => {
  const refundInput = (over: Partial<RefundInput>): RefundInput => ({
    ctx: ctx(),
    merchant_config: merchantConfig(),
    settlement_id: "7",
    amount: USDC(1230000),
    reason: "buyer changed mind",
    ...over,
  });

  it("relays a buyer-signed cancel and returns RefundOk + rail_metadata", async () => {
    h.performActionFn.mockResolvedValue({
      ok: true,
      txHash: "0xcancel",
      newExchangeState: "CANCELLED",
    });
    const payload = await cancelPayload(7n);
    const res = await makeAdapterReturning(snapshot("1230000", { state: "COMMITTED" })).refund(
      refundInput({ authority: { signed_payload: payload } }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toMatchObject({ refund_id: "7" });
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({ exchange_state: "CANCELLED" });
    expect(res.value.rail_metadata?.tx_hash).toBe("0xcancel");
    expect(h.performActionFn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "boson-cancelVoucher", exchangeId: "7" }),
    );
  });

  it("rejects a refund missing authority.signed_payload", async () => {
    const res = await makeAdapter().refund(refundInput({ authority: {} }));
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("rejects a non-cancel payload (a redeem meta-tx) before any relay", async () => {
    const redeemPayload = await buildExchangeMetaTx(
      "redeemVoucher(uint256)",
      encodeFunctionData({ abi: REDEEM_ABI_T, functionName: "redeemVoucher", args: [7n] }),
      7n,
    );
    const res = await makeAdapter().refund(
      refundInput({ authority: { signed_payload: redeemPayload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("rejects a cancel whose signed exchange id != settlement_id (self-binding)", async () => {
    const payload = await cancelPayload(999n);
    const res = await makeAdapter().refund(
      refundInput({ settlement_id: "7", authority: { signed_payload: payload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("refuses to cancel an exchange whose on-chain seller is not this merchant", async () => {
    const payload = await cancelPayload(7n);
    const res = await makeAdapterReturning(
      snapshot("1230000", {
        state: "COMMITTED",
        seller: "0x9999999999999999999999999999999999999999",
      }),
    ).refund(refundInput({ authority: { signed_payload: payload } }));
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("refuses to cancel an exchange no longer COMMITTED", async () => {
    const payload = await cancelPayload(7n);
    const res = await makeAdapterReturning(snapshot("1230000", { state: "REDEEMED" })).refund(
      refundInput({ authority: { signed_payload: payload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("maps a facilitator rejection to SETTLEMENT_FAILED (non-retryable)", async () => {
    h.performActionFn.mockResolvedValue({ ok: false, code: "SIMULATION_REVERT", reason: "revert" });
    const payload = await cancelPayload(7n);
    const res = await makeAdapterReturning(snapshot("1230000", { state: "COMMITTED" })).refund(
      refundInput({ authority: { signed_payload: payload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: false });
  });

  it("maps a facilitator throw to SETTLEMENT_FAILED (retryable)", async () => {
    h.performActionFn.mockRejectedValue(new Error("facilitator 502"));
    const payload = await cancelPayload(7n);
    const res = await makeAdapterReturning(snapshot("1230000", { state: "COMMITTED" })).refund(
      refundInput({ authority: { signed_payload: payload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
  });

  // FAIL-CLOSED: unlike capture/redeem, a refund whose escrow cannot be read on-chain
  // must NOT relay unbound (money leaves the escrow). It is refused (retryable), never
  // relayed — so a partial/foreign amount can never slip through a transient read miss.
  it("refuses (does not relay) when the escrow snapshot is unreadable (null reader)", async () => {
    const payload = await cancelPayload(7n);
    // makeAdapter's reader returns null (unreadable snapshot).
    const res = await makeAdapter().refund(refundInput({ authority: { signed_payload: payload } }));
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
    expect(h.performActionFn).not.toHaveBeenCalled();
  });

  it("refuses (does not relay) when the reader throws a transient error", async () => {
    const payload = await cancelPayload(7n);
    const res = await makeAdapterWithThrowingReader(new Error("subgraph 503")).refund(
      refundInput({ authority: { signed_payload: payload } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
    expect(h.performActionFn).not.toHaveBeenCalled();
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
      disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }),
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
      disputeInput({
        action: "accept",
        evidence: { signed_payload: await retractDisputePayload(7n) },
      }),
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
      disputeInput({
        evidence: { signed_payload: await escalateDisputePayload(7n), boson_action: "escalate" },
      }),
    );
    expect(h.disputeEscalateFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a dispute missing the signed meta-tx", async () => {
    const res = await makeAdapter().dispute(disputeInput({ evidence: {} }));
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
  });

  it("rejects a dispute payload that targets a DIFFERENT exchange before any relay", async () => {
    // The site bind the Terminal enforces is on the request's exchange_id; the
    // facilitator acts on the payload's OWN embedded id. validateDisputePayload
    // makes them the same or refuses — here the payload raises exchange 999 while
    // the input is exchange 7, so it never reaches the SDK handler.
    const foreign = await raiseDisputePayload(999n);
    const res = await makeAdapter().dispute(
      disputeInput({ evidence: { signed_payload: foreign } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    expect(h.disputeRaiseFn).not.toHaveBeenCalled();
  });

  it("rejects a non-dispute payload (a cancelVoucher) smuggled as a raise", async () => {
    // cancelVoucher shares the MetaTxExchange struct; accepted as a dispute it
    // would advance the wrong action. The function-name check refuses it offline.
    const notADispute = await cancelPayload(7n);
    const res = await makeAdapter().dispute(
      disputeInput({ evidence: { signed_payload: notADispute } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    expect(h.disputeRaiseFn).not.toHaveBeenCalled();
  });

  it("still relays resolve WITHOUT offline payload validation (counterparty-signed struct)", async () => {
    // resolve is the mutual settlement leg — a different, counterparty-signed
    // struct — so it is exempt from validateDisputePayload. A resolve with an
    // opaque payload must still reach the SDK handler (the on-chain resolveDispute
    // enforces the buyer/seller signatures itself).
    h.disputeResolveFn.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        txHash: "0xresolve",
        nextActions: {
          exchangeId: "7",
          exchangeState: "DISPUTED",
          disputeState: "RESOLVED",
          next: [],
        },
      },
    });
    const res = await makeAdapter().dispute(
      disputeInput({ evidence: { signed_payload: "0xabababab", boson_action: "resolve" } }),
    );
    expect(res.kind).toBe("ok");
    expect(h.disputeResolveFn).toHaveBeenCalledTimes(1);
  });

  it("surfaces the tx hash + escrow_state as rail_metadata on a clean raise", async () => {
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
      disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.rail_metadata?.tx_hash).toBe("0xraise");
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({ exchange_state: "DISPUTED" });
  });

  // ── 502/STATE_VERIFY_ subgraph-lag recovery ──────────────────────────────────
  // The facilitator relays the meta-tx, but the SDK's post-action verify may read a
  // LAGGING subgraph and 502 even though the transition already landed on-chain
  // (proven on mainnet 2026-07-17: raise + resolve both 502'd yet landed). The
  // adapter re-verifies the expected on-chain state before surfacing the false fail.
  const stateVerify502 = (code: string, txHash: string) => ({
    ok: false as const,
    status: 502,
    body: { code, reason: "post-action state verification failed", details: { txHash } },
  });

  it("recovers a raise false-fail: 502/STATE_VERIFY_ but the chain shows DISPUTED", async () => {
    h.disputeRaiseFn.mockResolvedValue(stateVerify502("STATE_VERIFY_STATE_MISMATCH", "0xraise"));
    const res = await makeAdapterReturning(
      snapshot("1230000", { state: "DISPUTED", disputeState: "RESOLVING" }),
    ).dispute(disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }));
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toMatchObject({ dispute_id: "7", status: "open" });
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({ exchange_state: "DISPUTED" });
    expect(res.value.rail_metadata?.tx_hash).toBe("0xraise");
  });

  it("recovers a resolve false-fail: matches the DISPUTE sub-state RESOLVED, not just DISPUTED", async () => {
    h.disputeResolveFn.mockResolvedValue(
      stateVerify502("STATE_VERIFY_DISPUTE_STATE_MISMATCH", "0xresolve"),
    );
    const res = await makeAdapterReturning(
      snapshot("1230000", { state: "DISPUTED", disputeState: "RESOLVED" }),
    ).dispute(
      disputeInput({ evidence: { signed_payload: "0xabababab", boson_action: "resolve" } }),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toMatchObject({ dispute_id: "7", status: "won" });
    expect(res.value.rail_metadata?.escrow_state).toMatchObject({ dispute_state: "RESOLVED" });
  });

  it("does NOT recover a resolve while the chain dispute is still RESOLVING (per-kind field)", async () => {
    // Exchange is DISPUTED but the dispute sub-state has not reached RESOLVED. A naive
    // exchange-state-only check would false-positive; disputeLanded requires RESOLVED.
    h.disputeResolveFn.mockResolvedValue(
      stateVerify502("STATE_VERIFY_DISPUTE_STATE_MISMATCH", "0xresolve"),
    );
    const res = await makeAdapterReturningWithExpiredBudget(
      snapshot("1230000", { state: "DISPUTED", disputeState: "RESOLVING" }),
    ).dispute(
      disputeInput({ evidence: { signed_payload: "0xabababab", boson_action: "resolve" } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
  });

  it("does NOT mask a hard reader error — surfaces the original 502", async () => {
    h.disputeRaiseFn.mockResolvedValue(stateVerify502("STATE_VERIFY_STATE_MISMATCH", "0xraise"));
    const res = await makeAdapterWithThrowingReader(new Error("rpc down")).dispute(
      disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
  });

  it("does NOT reverify a non-502 dispute rejection (409 passes straight through)", async () => {
    h.disputeRaiseFn.mockResolvedValue({
      ok: false,
      status: 409,
      body: { code: "EXCHANGE_STATE", reason: "not disputable", details: {} },
    });
    // Reader would throw if consulted — proves the guard short-circuits before any read.
    const res = await makeAdapterWithThrowingReader(new Error("should not read")).dispute(
      disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: false });
  });

  it("does NOT reverify a 502 that is not a STATE_VERIFY_ verify-lag (facilitator reject)", async () => {
    h.disputeRaiseFn.mockResolvedValue({
      ok: false,
      status: 502,
      body: { code: "FACILITATOR_REJECTED", reason: "relay refused", details: {} },
    });
    const res = await makeAdapterWithThrowingReader(new Error("should not read")).dispute(
      disputeInput({ evidence: { signed_payload: await raiseDisputePayload(7n) } }),
    );
    expect(res).toMatchObject({ kind: "error", code: "SETTLEMENT_FAILED", retryable: true });
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

// ─── handleWebhook secure default (requireWebhookSignature) ────────────────────

describe("BosonEscrowAdapter.handleWebhook requireWebhookSignature (secure default)", () => {
  const body = { exchangeId: "7", exchangeState: "COMPLETED" };

  function adapterWith(over: { requireWebhookSignature?: boolean }) {
    const rejections: WebhookRejection[] = [];
    const adapter = new BosonEscrowAdapter({
      facilitatorUrl: FACILITATOR,
      rpcUrl: RPC,
      exchangeReaderFactory: (_cfg: BosonMerchantConfig) => ({ read: async () => null }),
      mode: "development",
      now: () => Date.parse("2026-06-02T00:00:00.000Z"),
      webhookRejectionLogger: (r) => rejections.push(r),
      ...over,
    });
    return { adapter, rejections };
  }

  it("DEFAULT (no flag): a secret-less webhook is REFUSED UNAUTHORIZED, not trusted", async () => {
    // No requireWebhookSignature set → defaults to true. With no webhook_secret
    // there is nothing to verify against, so the adapter fails closed instead of
    // trusting an unauthenticated body — protects a third-party host that forgot
    // to verify upstream.
    const { adapter, rejections } = adapterWith({});
    const res = await adapter.handleWebhook({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      raw_body: new TextEncoder().encode(JSON.stringify(body)),
      parsed_body: body,
      headers: {},
    });
    expect(res).toMatchObject({
      kind: "error",
      code: "UNAUTHORIZED",
      native_code: "signature_verification_failed",
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: "missing_signature_header" });
  });

  it("requireWebhookSignature:false restores the lenient host-verified path (empty config)", async () => {
    const { adapter, rejections } = adapterWith({ requireWebhookSignature: false });
    const res = await adapter.handleWebhook({
      ctx: ctx(),
      merchant_config: {},
      raw_body: new TextEncoder().encode(JSON.stringify(body)),
      parsed_body: body,
      headers: {},
    });
    expect(res).toMatchObject({ kind: "ok", value: { kind: "settlement_confirmed" } });
    expect(rejections).toHaveLength(0);
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
