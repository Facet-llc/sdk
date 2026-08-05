import { describe, expect, it, vi } from "vitest";

import type { MerchantConfig, RailRequestContext } from "@facet-llc/adapter";

// Capture what the adapter passes to server.buildPaymentRequirements so we can
// assert the offer template carries the gate-critical fields verifyAuthority
// later checks (offer.creator == seller signer, escrow/asset/network/sellerId,
// amount) plus the demo dispute window. Keep the rest of the SDK real.
const h = vi.hoisted(() => ({ buildReqFn: vi.fn() }));

vi.mock("@bosonprotocol/x402-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bosonprotocol/x402-server")>();
  return {
    ...actual,
    createX402bServer: () => ({
      buildPaymentRequirements: h.buildReqFn,
      handlers: {},
    }),
  };
});

import { BosonEscrowAdapter, type BosonMerchantConfig } from "../src/adapter.ts";

const SELLER = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x7de418a7ce94debd057c34ebac232e7027634ade";
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const FACILITATOR = "https://facilitator.example.test";
const RPC = "https://base-sepolia-rpc.publicnode.com";
const HEX32 = ("0x" + "ab".repeat(32)) as `0x${string}`;

function merchantConfig(over: Partial<Record<string, unknown>> = {}): MerchantConfig {
  return {
    network: "eip155:84532",
    chainId: 84532,
    escrow: ESCROW,
    sellerId: "42",
    disputeResolverId: "1",
    asset: ASSET,
    facilitatorUrl: FACILITATOR,
    signer: { address: SELLER, signTypedData: vi.fn(async () => HEX32) },
    ...over,
  };
}

function ctx(): RailRequestContext {
  return {
    trace_id: "trace_q",
    idempotency_key: "idem_q",
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

describe("BosonEscrowAdapter.buildRequirements (402 producer)", () => {
  it("signs an offer whose creator/escrow/asset/sellerId match merchant_config", async () => {
    h.buildReqFn.mockReset();
    // Echo a requirements body so the result is well-formed.
    h.buildReqFn.mockImplementation((input: Record<string, unknown>) => ({
      scheme: "escrow",
      network: "eip155:84532",
      asset: input.asset,
      amount: input.amount,
      escrowAddress: ESCROW,
      recipientId: input.recipientId,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      offer: { creator: SELLER },
    }));

    const adapter = makeAdapter();
    const res = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 1_230_000, currency: "USDC" },
      options: { dispute_window_seconds: 600, max_timeout_seconds: 1800 },
    });

    expect(res.kind).toBe("ok");
    // The args handed to the Boson SDK producer.
    const arg = h.buildReqFn.mock.calls[0]![0] as {
      offer: { unsigned: Record<string, unknown> };
      asset: string;
      amount: string;
      recipientId: string;
      maxTimeoutSeconds: number;
      tokenAuthStrategies: readonly string[];
    };
    expect(arg.asset).toBe(ASSET);
    expect(arg.amount).toBe("1230000");
    expect(arg.recipientId).toBe("42");
    expect(arg.maxTimeoutSeconds).toBe(1800);
    expect(arg.tokenAuthStrategies).toContain("erc3009");

    // The offer template — the fields verifyAuthority's gate will check.
    const offer = arg.offer.unsigned;
    expect(offer.offerCreator).toBe(SELLER);
    expect(offer.exchangeToken).toBe(ASSET);
    expect(offer.sellerId).toBe("42");
    expect(offer.disputeResolverId).toBe("1");
    expect(offer.price).toBe("1230000");
    // feeLimit = ceil(price × 100bps / 10000) = ceil(1230000 × 100 / 10000) = 12300.
    expect(offer.feeLimit).toBe("12300");
    // sellerDeposit and agentId default to "0".
    expect(offer.sellerDeposit).toBe("0");
    expect(offer.agentId).toBe("0");
    // Real, resolvable BPIP-1 metadata URI served by the host server's
    // offer-metadata route; metadataHash is 0x-prefixed keccak-256.
    expect(offer.metadataUri).toContain("/v1/boson/offer-metadata?d=");
    expect(offer.metadataUri).not.toContain("ipfs://");
    expect(offer.metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
    // A short dispute window flows through to disputePeriodDurationInMS (ms).
    expect(offer.disputePeriodDurationInMS).toBe(String(600 * 1000));
  });

  it("threads fee_limit_bps, seller_deposit, agent_id, product + metadata base through the offer", async () => {
    h.buildReqFn.mockReset();
    h.buildReqFn.mockImplementation((input: Record<string, unknown>) => ({
      scheme: "escrow",
      network: "eip155:84532",
      asset: input.asset,
      amount: input.amount,
      escrowAddress: ESCROW,
      recipientId: input.recipientId,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      offer: { creator: SELLER },
    }));

    const adapter = makeAdapter();
    const res = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 2_000_000, currency: "USDC" },
      options: {
        fee_limit_bps: 250,
        seller_deposit_atomic: "500000",
        agent_id: "7",
        metadata_base_uri: "https://acme.facet.llc",
        product: {
          id: "prod-abc",
          name: "Acme Vitamin C Serum",
          description: "30ml brightening serum",
          category: "skincare",
          origin: "US",
          allergens: ["none"],
          tags: ["bestseller", "vegan"],
        },
      },
    });

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const offer = h.buildReqFn.mock.calls[0]![0]!.offer.unsigned as Record<string, unknown>;
    // ceil(2_000_000 * 250 / 10000) = 50_000
    expect(offer.feeLimit).toBe("50000");
    expect(offer.sellerDeposit).toBe("500000");
    expect(offer.agentId).toBe("7");
    expect(offer.metadataUri).toMatch(/^https:\/\/acme\.facet\.llc\/v1\/boson\/offer-metadata\?d=/);
    // The real metadata document is emitted in rail_metadata for the host.
    const meta = res.value.rail_metadata as Record<string, unknown>;
    expect(meta.metadata_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const doc = meta.metadata as { name: string; type: string };
    expect(doc.type).toBe("BASE");
    expect(doc.name).toBe("Acme Vitamin C Serum");
  });

  it("stamps the 'server' channel onto commit actions (x402-client pickAction needs it)", async () => {
    h.buildReqFn.mockReset();
    // The Boson SDK only ever emits facilitator/onchain on commit actions.
    h.buildReqFn.mockImplementation((input: Record<string, unknown>) => ({
      scheme: "escrow",
      network: "eip155:84532",
      asset: input.asset,
      amount: input.amount,
      escrowAddress: ESCROW,
      recipientId: input.recipientId,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      offer: { creator: SELLER },
      actions: {
        next: [
          { id: "boson-createOfferAndCommit", channels: ["facilitator", "onchain"] },
          { id: "boson-createOfferCommitAndRedeem", channels: ["facilitator", "onchain"] },
        ],
      },
    }));

    const adapter = makeAdapter();
    const res = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 1_230_000, currency: "USDC" },
      options: { dispute_window_seconds: 600, max_timeout_seconds: 1800 },
    });

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const req = res.value.requirements as unknown as {
      actions: { next: { channels: string[]; endpoints?: Record<string, string> }[] };
    };
    // The adapter must add "server" so the x402-client's pickAction (which
    // requires the commit action on the "server" channel) resolves; the
    // existing facilitator/onchain channels are preserved as fallbacks.
    for (const a of req.actions.next) {
      expect(a.channels).toContain("server");
      expect(a.channels).toContain("facilitator");
      expect(a.endpoints?.server).toBe("/v1/payments/dispatch");
    }
  });

  it("surfaces the advisory redeem_policy on the quote (default immediate; honors deferred)", async () => {
    h.buildReqFn.mockReset();
    h.buildReqFn.mockImplementation((input: Record<string, unknown>) => ({
      scheme: "escrow",
      network: "eip155:84532",
      asset: input.asset,
      amount: input.amount,
      escrowAddress: ESCROW,
      recipientId: input.recipientId,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      offer: { creator: SELLER },
    }));
    const adapter = makeAdapter();

    // Default → immediate.
    const def = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 1_000_000, currency: "USDC" },
    });
    expect(def.kind).toBe("ok");
    if (def.kind !== "ok") return;
    expect((def.value.rail_metadata as Record<string, unknown>).redeem_policy).toBe("immediate");

    // Explicit deferred → surfaced so the agent redeems only after delivery.
    const deferred = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 1_000_000, currency: "USDC" },
      options: { redeem_policy: "deferred" },
    });
    expect(deferred.kind).toBe("ok");
    if (deferred.kind !== "ok") return;
    expect((deferred.value.rail_metadata as Record<string, unknown>).redeem_policy).toBe(
      "deferred",
    );
  });

  it("rejects a non-USDC amount", async () => {
    const adapter = makeAdapter();
    const res = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig(),
      amount: { amount: 100, currency: "EUR" },
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.code).toBe("INVALID_REQUEST");
  });

  it("rejects a merchant_config missing the seller signer", async () => {
    const adapter = makeAdapter();
    const res = await adapter.quoteRequirements!({
      ctx: ctx(),
      merchant_config: merchantConfig({ signer: undefined }),
      amount: { amount: 1_230_000, currency: "USDC" },
    });
    expect(res.kind).toBe("error");
  });
});
