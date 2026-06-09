import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { X402CoinbaseAdapter, type SettlementConfirmer } from "../src/adapter.ts";
import { decodePaymentHeader, encodePaymentHeader } from "../src/payment-header.ts";

// USDC EIP-712 domain on base-sepolia. Pulled directly from
// https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
const BASE_SEPOLIA_USDC_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const,
};

// Hardhat/Foundry deterministic test key #0. Public-knowledge value used
// across the Ethereum dev ecosystem; carries no value on any chain.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function buildSignedHeader(opts: {
  to: `0x${string}`;
  value: string;
  validBefore: string;
  nonce: `0x${string}`;
  network?: "base" | "base-sepolia";
}): Promise<string> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const authorization = {
    from: account.address.toLowerCase(),
    to: opts.to,
    value: opts.value,
    validAfter: "0",
    validBefore: opts.validBefore,
    nonce: opts.nonce,
  };
  const signature = await account.signTypedData({
    domain: BASE_SEPOLIA_USDC_DOMAIN,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return encodePaymentHeader({
    x402Version: 1,
    scheme: "exact",
    network: opts.network ?? "base-sepolia",
    payload: { signature, authorization },
  });
}

/** Build an adapter with a mocked facilitator. Mocking is done by
 *  swapping global fetch — the x402 SDK's facilitator client calls fetch
 *  to hit the configured URL. */
function makeAdapterWithMockedFacilitator(opts: {
  verifyValid?: boolean;
  verifyReason?: string;
  settleSuccess?: boolean;
  settleTx?: `0x${string}`;
  settleErrorReason?: string;
  confirmSettlement?: SettlementConfirmer;
  maxAuthWindowSeconds?: number;
  now?: () => number;
}) {
  const verifyResponse = {
    isValid: opts.verifyValid !== false,
    invalidReason: opts.verifyReason,
  };
  const settleResponse = {
    success: opts.settleSuccess !== false,
    transaction: opts.settleTx ?? `0x${"de".repeat(32)}`,
    network: "base-sepolia",
    errorReason: opts.settleErrorReason,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/verify")) {
      return new Response(JSON.stringify(verifyResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/settle")) {
      return new Response(JSON.stringify(settleResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Unhandled", { status: 404 });
  }) as unknown as typeof fetch;
  const restore = () => {
    globalThis.fetch = originalFetch;
  };
  const adapter = new X402CoinbaseAdapter({
    network: "base-sepolia",
    facilitator: { url: "https://facilitator.test.local" },
    ...(opts.confirmSettlement ? { confirmSettlement: opts.confirmSettlement } : {}),
    ...(opts.maxAuthWindowSeconds !== undefined
      ? { maxAuthWindowSeconds: opts.maxAuthWindowSeconds }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { adapter, restore };
}

const ctx = {
  trace_id: "trace_test",
  idempotency_key: "idem_test",
  merchant_id: "merch_test",
  site_id: "site_test",
  received_at: "2026-05-24T00:00:00Z",
};

// ─────────────────────────────────────────────────────────────────────────────
// Header codec
// ─────────────────────────────────────────────────────────────────────────────

describe("decodePaymentHeader", () => {
  it("round-trips a valid signed payload through encode + decode", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"01".repeat(32)}`,
    });
    const decoded = decodePaymentHeader(header);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind === "ok") {
      expect(decoded.payload.x402Version).toBe(1);
      expect(decoded.payload.network).toBe("base-sepolia");
    }
  });

  it("rejects non-base64 input", () => {
    const result = decodePaymentHeader("not base64 !!@@##");
    expect(result.kind).toBe("error");
  });

  it("rejects payload that fails x402 schema validation", () => {
    const result = decodePaymentHeader(btoa(JSON.stringify({ not: "an x402 payload" })));
    expect(result.kind).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adapter metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter metadata", () => {
  it("declares coin/usdc-base-sepolia for sepolia", () => {
    const adapter = new X402CoinbaseAdapter({ network: "base-sepolia" });
    expect(adapter.metadata.id).toBe("coin/usdc-base-sepolia");
    expect(adapter.metadata.supports_reserve_capture).toBe(false);
    expect(adapter.metadata.supports_refund).toBe(true);
    expect(adapter.metadata.supports_dispute).toBe(false);
    expect(adapter.metadata.currencies).toContain("USDC");
    expect(adapter.metadata.networks).toEqual(["base-sepolia"]);
  });

  it("declares coin/usdc-base for mainnet", () => {
    const adapter = new X402CoinbaseAdapter({ network: "base", baseEip712Verified: true });
    expect(adapter.metadata.id).toBe("coin/usdc-base");
    expect(adapter.metadata.networks).toEqual(["base"]);
  });

  it("refuses to construct a base-mainnet adapter without baseEip712Verified", () => {
    expect(() => new X402CoinbaseAdapter({ network: "base" })).toThrow(/baseEip712Verified/);
  });

  it("populates egress_allowlist from the facilitator URL", () => {
    const adapter = new X402CoinbaseAdapter({
      network: "base-sepolia",
      facilitator: { url: "https://my.facilitator.test" },
    });
    expect(adapter.metadata.egress_allowlist).toEqual(["https://my.facilitator.test"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyAuthority — full flow through the real x402 SDK + mocked facilitator
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter.verifyAuthority", () => {
  it("accepts a correctly-signed payload when facilitator returns isValid", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"11".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({ verifyValid: true });
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USDC" },
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.authority_handle).toBe(`0x${"11".repeat(32)}`);
      }
    } finally {
      restore();
    }
  });

  it("returns UNAUTHORIZED when facilitator rejects the payload", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"22".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      verifyValid: false,
      verifyReason: "invalid_exact_evm_payload_signature",
    });
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USDC" },
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("UNAUTHORIZED");
        expect(result.native_code).toBe("invalid_exact_evm_payload_signature");
      }
    } finally {
      restore();
    }
  });

  it("rejects when currency is not USDC", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"33".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({});
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USD" },
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message).toContain("not supported");
    } finally {
      restore();
    }
  });

  it("rejects when network in payload doesn't match adapter network", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"44".repeat(32)}`,
      network: "base",
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({});
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USDC" },
      });
      expect(result.kind).toBe("error");
    } finally {
      restore();
    }
  });

  it("rejects when authority.x_payment is missing", async () => {
    const { adapter, restore } = makeAdapterWithMockedFacilitator({});
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: {},
        amount: { amount: 1, currency: "USDC" },
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reserveAuthority — instant-settle no-op
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter.reserveAuthority", () => {
  it("is a no-op (x402 settles instantly)", async () => {
    const adapter = new X402CoinbaseAdapter({ network: "base-sepolia" });
    const result = await adapter.reserveAuthority({
      ctx,
      merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
      authority_handle: "0xabc",
      amount: { amount: 1, currency: "USDC" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.reservation_active).toBe(false);
      expect(result.value.reserved_until).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// capture
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter.capture", () => {
  it("returns the facilitator transaction hash on success", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"66".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      settleSuccess: true,
      settleTx: `0x${"77".repeat(32)}`,
    });
    try {
      const result = await adapter.capture({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority_handle: `0x${"66".repeat(32)}`,
        amount: { amount: 1000000, currency: "USDC" },
        ...({ authority: { x_payment: header } } as unknown as object),
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.settlement_id).toBe(`0x${"77".repeat(32)}`);
      }
    } finally {
      restore();
    }
  });

  it("returns SETTLEMENT_FAILED with native_code when facilitator declines", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"88".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      settleSuccess: false,
      settleErrorReason: "insufficient_funds",
    });
    try {
      const result = await adapter.capture({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority_handle: `0x${"88".repeat(32)}`,
        amount: { amount: 1000000, currency: "USDC" },
        ...({ authority: { x_payment: header } } as unknown as object),
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("SETTLEMENT_FAILED");
        expect(result.native_code).toBe("insufficient_funds");
      }
    } finally {
      restore();
    }
  });

  it("rejects when authority_handle doesn't match the X-PAYMENT nonce", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"99".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({});
    try {
      const result = await adapter.capture({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority_handle: "0xdeadbeef",
        amount: { amount: 1000000, currency: "USDC" },
        ...({ authority: { x_payment: header } } as unknown as object),
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("INVALID_REQUEST");
        expect(result.message).toContain("does not match");
      }
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hardening — independent value check, validity window, and on-chain
// settlement confirmation
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter hardening", () => {
  it("rejects when the signed value != server-derived amount", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1", // attacker signs 1 atomic unit
      validBefore: "1800000000",
      nonce: `0x${"a1".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({ verifyValid: true });
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USDC" }, // server requires 1.0 USDC
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("UNAUTHORIZED");
        expect(result.native_code).toBe("amount_mismatch");
      }
    } finally {
      restore();
    }
  });

  it("rejects an over-long authorization window when maxAuthWindowSeconds is set", async () => {
    const fixedNowMs = 1_800_000_000_000; // validBefore below is ~231 days later
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1820000000",
      nonce: `0x${"a2".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      verifyValid: true,
      maxAuthWindowSeconds: 600,
      now: () => fixedNowMs,
    });
    try {
      const result = await adapter.verifyAuthority({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority: { x_payment: header },
        amount: { amount: 1000000, currency: "USDC" },
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("UNAUTHORIZED");
        expect(result.native_code).toBe("auth_window_too_long");
      }
    } finally {
      restore();
    }
  });

  it("fails capture when on-chain confirmation returns ok:false", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"a3".repeat(32)}`,
    });
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      settleSuccess: true,
      settleTx: `0x${"ab".repeat(32)}`,
      confirmSettlement: () => Promise.resolve({ ok: false, reason: "no Transfer log to payTo" }),
    });
    try {
      const result = await adapter.capture({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority_handle: `0x${"a3".repeat(32)}`,
        amount: { amount: 1000000, currency: "USDC" },
        ...({ authority: { x_payment: header } } as unknown as object),
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("SETTLEMENT_FAILED");
        expect(result.native_code).toBe("settlement_unconfirmed");
      }
    } finally {
      restore();
    }
  });

  it("passes capture when on-chain confirmation returns ok:true, binding payTo+value", async () => {
    const header = await buildSignedHeader({
      to: MERCHANT_ADDRESS,
      value: "1000000",
      validBefore: "1800000000",
      nonce: `0x${"a4".repeat(32)}`,
    });
    const seen: { payTo?: string; minValueAtomic?: string } = {};
    const { adapter, restore } = makeAdapterWithMockedFacilitator({
      settleSuccess: true,
      settleTx: `0x${"cd".repeat(32)}`,
      confirmSettlement: (p) => {
        seen.payTo = p.payTo;
        seen.minValueAtomic = p.minValueAtomic;
        return Promise.resolve({ ok: true });
      },
    });
    try {
      const result = await adapter.capture({
        ctx,
        merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
        authority_handle: `0x${"a4".repeat(32)}`,
        amount: { amount: 1000000, currency: "USDC" },
        ...({ authority: { x_payment: header } } as unknown as object),
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.value.settlement_id).toBe(`0x${"cd".repeat(32)}`);
      expect(seen.payTo?.toLowerCase()).toBe(MERCHANT_ADDRESS.toLowerCase());
      expect(seen.minValueAtomic).toBe("1000000");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refund + webhook stubs
// ─────────────────────────────────────────────────────────────────────────────

describe("X402CoinbaseAdapter.refund", () => {
  it("returns METHOD_NOT_ALLOWED until Phase 5 merchant signer wiring lands", async () => {
    const adapter = new X402CoinbaseAdapter({ network: "base-sepolia" });
    const result = await adapter.refund({
      ctx,
      merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
      settlement_id: "0xdeadbeef",
      amount: { amount: 1, currency: "USDC" },
      reason: "test",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("X402CoinbaseAdapter.handleWebhook", () => {
  it("ignores inbound webhooks (Coinbase facilitator is synchronous)", async () => {
    const adapter = new X402CoinbaseAdapter({ network: "base-sepolia" });
    const result = await adapter.handleWebhook({
      ctx,
      merchant_config: { x402_pay_to_address: MERCHANT_ADDRESS },
      raw_body: new Uint8Array(),
      parsed_body: {},
      headers: {},
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.kind).toBe("ignored");
  });
});
