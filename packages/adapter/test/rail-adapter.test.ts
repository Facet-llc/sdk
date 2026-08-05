import { describe, expect, it } from "vitest";

import type {
  AgentPrincipal,
  FacetOriginationVerifier,
  FacetPaymentRailAdapter,
  OriginationVerifierMetadata,
  RailAdapterMetadata,
  RailAdapterResult,
  VerifyAttestationResult,
} from "../src/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Conformance fixtures — minimal in-memory implementations of both
// interfaces. Adapter authors can copy these as the starting shape and
// extend with their rail's actual logic.
// ─────────────────────────────────────────────────────────────────────────────

const X402_FIXTURE_METADATA: RailAdapterMetadata = {
  id: "coin/usdc-base",
  display_name: "USDC on Base (x402)",
  version: "0.0.0-fixture",
  supports_reserve_capture: false,
  supports_refund: true,
  supports_dispute: false,
  networks: ["base-mainnet", "base-sepolia"],
  currencies: ["USDC"],
  egress_allowlist: ["https://x402-facilitator.cdp.coinbase.com"],
};

const STRIPE_FIXTURE_METADATA: RailAdapterMetadata = {
  id: "card/stripe",
  display_name: "Stripe Cards / ACH",
  version: "0.0.0-fixture",
  supports_reserve_capture: true,
  supports_refund: true,
  supports_dispute: true,
  networks: ["visa", "mastercard", "amex", "ach"],
  currencies: ["USD", "EUR", "GBP"],
  egress_allowlist: ["https://api.stripe.com"],
};

const AGENTCORE_VERIFIER_METADATA: OriginationVerifierMetadata = {
  id: "issuer/aws-agentcore",
  display_name: "AWS Bedrock AgentCore",
  version: "0.0.0-fixture",
  kind: "jwt",
  issuer_url: "https://bedrock-agentcore.us-east-1.amazonaws.com",
  verify_is_local: false,
  egress_allowlist: ["https://bedrock-agentcore.us-east-1.amazonaws.com"],
};

const DIRECT_VERIFIER_METADATA: OriginationVerifierMetadata = {
  id: "issuer/direct",
  display_name: "Unattested (x402 wallet only)",
  version: "0.0.0-fixture",
  kind: "direct",
  issuer_url: null,
  verify_is_local: true,
  egress_allowlist: [],
};

/** Minimal stub adapter — returns ok for everything; exists only to
 *  prove the interface compiles against a realistic implementation. */
const stubAdapter: FacetPaymentRailAdapter = {
  metadata: X402_FIXTURE_METADATA,
  async verifyAuthority({ amount }) {
    return {
      kind: "ok",
      value: {
        authority_handle: `auth_${amount.amount}_${amount.currency}`,
        expires_at: null,
      },
    };
  },
  async reserveAuthority() {
    return {
      kind: "ok",
      value: { reservation_active: false, reserved_until: null },
    };
  },
  async capture({ authority_handle }) {
    return {
      kind: "ok",
      value: {
        settlement_id: `settled_${authority_handle}`,
        settled_at: "2026-05-24T00:00:00Z",
      },
    };
  },
  async refund({ settlement_id }) {
    return {
      kind: "ok",
      value: {
        refund_id: `ref_${settlement_id}`,
        refunded_at: "2026-05-24T00:00:00Z",
      },
    };
  },
  async handleWebhook() {
    return { kind: "ok", value: { kind: "ignored", reason: "stub" } };
  },
};

const stubVerifier: FacetOriginationVerifier = {
  metadata: DIRECT_VERIFIER_METADATA,
  async verify({ raw_attestation }): Promise<VerifyAttestationResult> {
    const principal: AgentPrincipal = {
      aid: `direct:${raw_attestation || "anon"}`,
      issuer: "issuer/direct",
      scopes: [],
      expires_at: null,
      issued_at: "2026-05-24T00:00:00Z",
      max_spend_amount: null,
      max_spend_currency: null,
      raw_claims: {},
    };
    return { kind: "ok", principal };
  },
  async warmKeys() {
    return;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("RailAdapterMetadata", () => {
  it("namespace ids follow `<category>/<rail>` convention", () => {
    for (const meta of [X402_FIXTURE_METADATA, STRIPE_FIXTURE_METADATA]) {
      expect(meta.id).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
    }
  });

  it("x402 fixture advertises instant-settle (no reserve/capture split)", () => {
    expect(X402_FIXTURE_METADATA.supports_reserve_capture).toBe(false);
  });

  it("stripe fixture advertises two-step + dispute support", () => {
    expect(STRIPE_FIXTURE_METADATA.supports_reserve_capture).toBe(true);
    expect(STRIPE_FIXTURE_METADATA.supports_dispute).toBe(true);
  });

  it("egress_allowlist is populated for network-bound rails", () => {
    for (const meta of [X402_FIXTURE_METADATA, STRIPE_FIXTURE_METADATA]) {
      expect(meta.egress_allowlist.length).toBeGreaterThan(0);
    }
  });
});

describe("FacetPaymentRailAdapter contract", () => {
  const ctx = {
    trace_id: "trace_test",
    idempotency_key: "idem_test",
    merchant_id: "merch_test",
    site_id: "site_test",
    received_at: "2026-05-24T00:00:00Z",
  };

  it("verifyAuthority -> ok produces a handle the Terminal can re-present", async () => {
    const result = await stubAdapter.verifyAuthority({
      ctx,
      merchant_config: {},
      authority: { foo: "bar" },
      amount: { amount: 100, currency: "USDC" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(typeof result.value.authority_handle).toBe("string");
      expect(result.value.authority_handle.length).toBeGreaterThan(0);
    }
  });

  it("capture happy path returns settlement_id + settled_at", async () => {
    const result = await stubAdapter.capture({
      ctx,
      merchant_config: {},
      authority_handle: "auth_xyz",
      amount: { amount: 100, currency: "USDC" },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.settlement_id).toContain("auth_xyz");
      expect(result.value.settled_at).toMatch(/Z$/);
    }
  });

  it("RailAdapterResult.kind discriminates all three variants", () => {
    const ok: RailAdapterResult<number> = { kind: "ok", value: 1 };
    const limited: RailAdapterResult<number> = {
      kind: "rate_limited",
      retry_after_seconds: 30,
    };
    const err: RailAdapterResult<number> = {
      kind: "error",
      code: "SETTLEMENT_FAILED",
      message: "downstream 500",
      retryable: true,
    };
    expect(ok.kind).toBe("ok");
    expect(limited.kind).toBe("rate_limited");
    expect(err.kind).toBe("error");
  });
});

describe("FacetOriginationVerifier contract", () => {
  it("verify -> ok produces a principal with namespaced aid", async () => {
    const result = await stubVerifier.verify({
      raw_attestation: "0xabc",
      trace_id: "trace_test",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.principal.aid).toMatch(/^[a-z]+:/);
      expect(result.principal.issuer).toBe(stubVerifier.metadata.id);
    }
  });

  it("warmKeys is callable and returns void", async () => {
    await expect(stubVerifier.warmKeys()).resolves.toBeUndefined();
  });
});

describe("AgentCore verifier metadata invariants", () => {
  it("non-local verifier must declare its issuer_url", () => {
    expect(AGENTCORE_VERIFIER_METADATA.verify_is_local).toBe(false);
    expect(AGENTCORE_VERIFIER_METADATA.issuer_url).not.toBeNull();
  });

  it("non-local verifier must declare egress destinations", () => {
    expect(AGENTCORE_VERIFIER_METADATA.egress_allowlist.length).toBeGreaterThan(0);
  });

  it("direct verifier may skip issuer_url and egress", () => {
    expect(DIRECT_VERIFIER_METADATA.issuer_url).toBeNull();
    expect(DIRECT_VERIFIER_METADATA.egress_allowlist.length).toBe(0);
    expect(DIRECT_VERIFIER_METADATA.verify_is_local).toBe(true);
  });
});
