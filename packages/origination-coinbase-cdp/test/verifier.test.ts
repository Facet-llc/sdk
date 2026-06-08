// Tests sign envelopes with a real viem private-key account and verify
// them through the real verifier. The CDP-client cross-check path uses
// a hand-rolled stub matching the CdpClient.evm.getAccount shape.

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import {
  CoinbaseCdpOriginationVerifier,
  InMemoryReplayCache,
  canonicalMessage,
  encodeAttestationHeader,
  normalizeLowS,
  type CdpAttestationEnvelope,
  type ReplayCache,
} from "../src/verifier.ts";

// Hardhat/Foundry deterministic test key #0 — public-knowledge value,
// carries no value on any chain.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

async function buildSignedEnvelope(
  overrides: Partial<CdpAttestationEnvelope> = {},
  opts: { signWithDifferentKey?: boolean } = {},
): Promise<CdpAttestationEnvelope> {
  const signingKey = opts.signWithDifferentKey
    ? ("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const)
    : TEST_PRIVATE_KEY;
  const account = privateKeyToAccount(signingKey);
  const wallet = overrides.wallet ?? (privateKeyToAccount(TEST_PRIVATE_KEY).address as Address);
  const now = Date.now();
  // bind_to is required on every envelope now. Default test
  // value is a unique-per-call string so the replay cache doesn't
  // bleed between tests; explicit overrides win.
  const bindTo = overrides.bind_to ?? `test-bind-${crypto.randomUUID()}`;
  const baseEnvelope = {
    wallet,
    issued_at: overrides.issued_at ?? new Date(now).toISOString(),
    expires_at: overrides.expires_at ?? new Date(now + 5 * 60_000).toISOString(),
    bind_to: bindTo,
    ...(overrides.scopes !== undefined ? { scopes: overrides.scopes } : {}),
  };
  const signature = await account.signMessage({ message: canonicalMessage(baseEnvelope) });
  return { ...baseEnvelope, signature };
}

const TRACE_ID = "trace_test";

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("CoinbaseCdpOriginationVerifier metadata", () => {
  it("declares issuer/coinbase-cdp + verify_is_local true when no CdpClient", () => {
    const v = new CoinbaseCdpOriginationVerifier();
    expect(v.metadata.id).toBe("issuer/coinbase-cdp");
    expect(v.metadata.verify_is_local).toBe(true);
    expect(v.metadata.issuer_url).toBeNull();
    expect(v.metadata.egress_allowlist).toEqual([]);
  });

  it("declares CDP egress when a CdpClient is wired", () => {
    const stubClient = { evm: { getAccount: async () => ({}) } } as never;
    const v = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient });
    expect(v.metadata.verify_is_local).toBe(false);
    expect(v.metadata.issuer_url).toBe("https://api.developer.coinbase.com");
    expect(v.metadata.egress_allowlist).toEqual(["https://api.developer.coinbase.com"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify — happy + reject paths
// ─────────────────────────────────────────────────────────────────────────────

describe("CoinbaseCdpOriginationVerifier.verify", () => {
  it("returns an AgentPrincipal aid=cdp:<wallet> for a valid envelope", async () => {
    const envelope = await buildSignedEnvelope({ scopes: ["payments:write"] });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.principal.aid).toBe(`cdp:${envelope.wallet.toLowerCase()}`);
    expect(result.principal.issuer).toBe("issuer/coinbase-cdp");
    expect(result.principal.scopes).toEqual(["payments:write"]);
  });

  it("rejects when signature is from a different key than the claimed wallet", async () => {
    const envelope = await buildSignedEnvelope({}, { signWithDifferentKey: true });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("signature_invalid");
  });

  it("rejects an expired envelope", async () => {
    const past = Date.now() - 10 * 60_000;
    const envelope = await buildSignedEnvelope({
      issued_at: new Date(past).toISOString(),
      expires_at: new Date(past + 60_000).toISOString(),
    });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("expired");
  });

  it("rejects an envelope minted too far in the past (maxEnvelopeAgeSeconds)", async () => {
    const past = Date.now() - 20 * 60_000;
    const envelope = await buildSignedEnvelope({
      issued_at: new Date(past).toISOString(),
      expires_at: new Date(past + 30 * 60_000).toISOString(),
    });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier({ maxEnvelopeAgeSeconds: 600 });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("expired");
  });

  it("rejects an envelope issued in the future", async () => {
    const future = Date.now() + 10 * 60_000;
    const envelope = await buildSignedEnvelope({
      issued_at: new Date(future).toISOString(),
      expires_at: new Date(future + 5 * 60_000).toISOString(),
    });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("not_yet_valid");
  });

  it("rejects bind_to mismatch when caller supplies bind_to", async () => {
    const envelope = await buildSignedEnvelope({ bind_to: "envelope-nonce" });
    const header = encodeAttestationHeader(envelope);

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({
      raw_attestation: header,
      trace_id: TRACE_ID,
      bind_to: "different-nonce",
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("binding_mismatch");
  });

  it("rejects a non-base64 attestation", async () => {
    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({
      raw_attestation: "not base64 !!@@##",
      trace_id: TRACE_ID,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("malformed");
  });

  it("rejects raw_attestation over the 8 KB size cap without parsing", async () => {
    const v = new CoinbaseCdpOriginationVerifier();
    const oversized = "A".repeat(10_000);
    expect(oversized.length).toBeGreaterThan(8192);
    const result = await v.verify({
      raw_attestation: oversized,
      trace_id: TRACE_ID,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("malformed");
      expect(result.message).toContain("size cap");
    }
  });

  it("rejects an envelope with a malformed wallet field", async () => {
    const env = await buildSignedEnvelope();
    const tampered = { ...env, wallet: "not-an-address" };
    const header = btoa(JSON.stringify(tampered));

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("malformed");
  });

  it("rejects an envelope with a mutated bind_to after signing", async () => {
    // Tampering with the envelope after signing changes the canonical
    // message and breaks the signature.
    const env = await buildSignedEnvelope({ bind_to: "original" });
    const tampered = { ...env, bind_to: "tampered" };
    const header = btoa(JSON.stringify(tampered));

    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("signature_invalid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional CdpClient cross-check
// ─────────────────────────────────────────────────────────────────────────────

describe("CoinbaseCdpOriginationVerifier with cdpClient cross-check", () => {
  it("calls cdpClient.evm.getAccount and accepts when the wallet exists", async () => {
    const envelope = await buildSignedEnvelope();
    const header = encodeAttestationHeader(envelope);
    const stubClient = {
      evm: {
        getAccount: async () => ({
          address: envelope.wallet,
          name: "test",
          type: "evm-server" as const,
        }),
      },
    } as never;
    const v = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("ok");
  });

  it("rejects with issuer_unknown when CdpClient says the account is not found", async () => {
    const envelope = await buildSignedEnvelope();
    const header = encodeAttestationHeader(envelope);
    const stubClient = {
      evm: {
        getAccount: async () => {
          throw new Error("Account not found (404)");
        },
      },
    } as never;
    const v = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("issuer_unknown");
  });

  it("fail-closed — CdpClient transient error rejects with issuer_unknown (not retryable error)", async () => {
    const envelope = await buildSignedEnvelope();
    const header = encodeAttestationHeader(envelope);
    const stubClient = {
      evm: {
        getAccount: async () => {
          throw new Error("network timeout");
        },
      },
    } as never;
    const v = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    // Previously this was kind:'error' retryable:true — attacker could
    // time their dispatch against a CDP outage to bypass the cross-
    // check. Now the merchant's cdpClient opt-in means fail-closed:
    // the dispatch is rejected (UNAUTHORIZED), not retried.
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("issuer_unknown");
      expect(result.message).toContain("cannot be confirmed registered");
    }
  });

  it("5xx-style errors also fail-closed (not just 404)", async () => {
    const envelope = await buildSignedEnvelope();
    const header = encodeAttestationHeader(envelope);
    const stubClient = {
      evm: {
        getAccount: async () => {
          throw new Error("503 Service Unavailable");
        },
      },
    } as never;
    const v = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("issuer_unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// �� required bind_to + replay cache + low-s normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("bind_to is required", () => {
  it("rejects an envelope with missing bind_to as malformed", async () => {
    // Build an envelope manually without bind_to, sign the matching
    // canonical message (with an empty bind_to line), then drop the
    // bind_to field before encoding. The parseEnvelope step must
    // reject before the signature check runs.
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const now = Date.now();
    const obj = {
      wallet: account.address,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      signature: "0x".padEnd(132, "0"),
    };
    const header = btoa(JSON.stringify(obj));
    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("malformed");
      expect(result.message).toContain("bind_to is required");
    }
  });

  it("rejects an envelope with empty-string bind_to as malformed", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const now = Date.now();
    const obj = {
      wallet: account.address,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      bind_to: "",
      signature: "0x".padEnd(132, "0"),
    };
    const header = btoa(JSON.stringify(obj));
    const v = new CoinbaseCdpOriginationVerifier();
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("malformed");
  });
});

describe("server-side replay cache", () => {
  it("rejects the second verify of the same (wallet, signature) tuple as binding_mismatch", async () => {
    const envelope = await buildSignedEnvelope({ bind_to: "replay-test-1" });
    const header = encodeAttestationHeader(envelope);
    const v = new CoinbaseCdpOriginationVerifier();
    const first = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(first.kind).toBe("ok");
    const second = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(second.kind).toBe("rejected");
    if (second.kind === "rejected") {
      expect(second.reason).toBe("binding_mismatch");
      expect(second.message).toContain("replay detected");
    }
  });

  it("accepts two envelopes with distinct signatures (different bind_to changes the signature)", async () => {
    const envA = await buildSignedEnvelope({ bind_to: "nonce-a" });
    const envB = await buildSignedEnvelope({ bind_to: "nonce-b" });
    const v = new CoinbaseCdpOriginationVerifier();
    const rA = await v.verify({
      raw_attestation: encodeAttestationHeader(envA),
      trace_id: TRACE_ID,
    });
    const rB = await v.verify({
      raw_attestation: encodeAttestationHeader(envB),
      trace_id: TRACE_ID,
    });
    expect(rA.kind).toBe("ok");
    expect(rB.kind).toBe("ok");
  });

  it("does NOT add to the replay cache when cdpClient rejects (no cache poisoning)", async () => {
    // If the CDP cross-check rejects, the envelope was never accepted —
    // it must not occupy a replay slot. Otherwise an attacker could
    // burn a victim's signature slot by triggering a CDP failure on a
    // verify they don't intend to settle.
    const envelope = await buildSignedEnvelope({ bind_to: "no-poison" });
    const header = encodeAttestationHeader(envelope);
    const stubClient = {
      evm: {
        getAccount: async () => {
          throw new Error("404 not found");
        },
      },
    } as never;
    const replayCache = new InMemoryReplayCache();
    const v1 = new CoinbaseCdpOriginationVerifier({ cdpClient: stubClient, replayCache });
    const r1 = await v1.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(r1.kind).toBe("rejected");
    // Re-verify on a NEW verifier without cdpClient (simulating
    // operator disabling the cross-check) — the signature should still
    // be acceptable on first use because the previous failure didn't
    // poison the cache.
    const v2 = new CoinbaseCdpOriginationVerifier({ replayCache });
    const r2 = await v2.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(r2.kind).toBe("ok");
  });

  it("uses the injected ReplayCache for cross-instance replay defense", async () => {
    const sharedCache = new InMemoryReplayCache();
    const envelope = await buildSignedEnvelope({ bind_to: "cross-inst-test" });
    const header = encodeAttestationHeader(envelope);
    const vA = new CoinbaseCdpOriginationVerifier({ replayCache: sharedCache });
    const vB = new CoinbaseCdpOriginationVerifier({ replayCache: sharedCache });
    const r1 = await vA.verify({ raw_attestation: header, trace_id: TRACE_ID });
    const r2 = await vB.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("rejected");
    if (r2.kind === "rejected") expect(r2.reason).toBe("binding_mismatch");
  });

  it("custom ReplayCache implementations are honored", async () => {
    const calls: string[] = [];
    const cache: ReplayCache = {
      has(key: string) {
        calls.push(`has:${key.slice(0, 12)}`);
        return false;
      },
      add(key: string, ttlMs: number) {
        calls.push(`add:${key.slice(0, 12)}:ttl=${ttlMs}`);
      },
    };
    const envelope = await buildSignedEnvelope({ bind_to: "custom-cache" });
    const header = encodeAttestationHeader(envelope);
    const v = new CoinbaseCdpOriginationVerifier({ replayCache: cache });
    const result = await v.verify({ raw_attestation: header, trace_id: TRACE_ID });
    expect(result.kind).toBe("ok");
    expect(calls.length).toBe(2);
    expect(calls[0]!.startsWith("has:")).toBe(true);
    expect(calls[1]!.startsWith("add:")).toBe(true);
  });
});

describe("low-s ECDSA signature normalization", () => {
  it("normalizeLowS returns a low-s signature unchanged", () => {
    // r = 1, s = N/2 - 1 → already canonical
    const r = "01".padStart(64, "0");
    const s = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0")
      .toString(16)
      .padStart(64, "0");
    const v = "1b";
    const sig = "0x" + r + s + v;
    expect(normalizeLowS(sig)).toBe(sig.toLowerCase());
  });

  it("normalizeLowS folds a high-s signature down to the low-s twin and flips v", () => {
    // Build a high-s signature explicitly. The low-s value is what
    // n - high_s evaluates to; both must land on the same key when
    // used as the replay cache key.
    const SECP256K1_N = BigInt(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    );
    const r = "ab".padStart(64, "0");
    const lowS = BigInt("0x5d576e7357a4501ddfe92f46681b20a0123456789abcdef0123456789abcdef0");
    const highS = SECP256K1_N - lowS;
    const highSHex = highS.toString(16).padStart(64, "0");
    const lowSHex = lowS.toString(16).padStart(64, "0");
    const highV = "1c";
    const lowV = "1b";
    const highSig = "0x" + r + highSHex + highV;
    const expectedLow = "0x" + r + lowSHex + lowV;
    expect(normalizeLowS(highSig)).toBe(expectedLow);
  });

  it("captured-signature high-s twin replays as the same cache key", async () => {
    // End-to-end: build a real envelope, normalize its signature, then
    // construct the high-s twin and confirm normalizeLowS folds them
    // to the same string. This is the property that makes the replay
    // cache survive an ECDSA-malleability attacker.
    const envelope = await buildSignedEnvelope({ bind_to: "twin-test" });
    const sig = envelope.signature;
    const normalized = normalizeLowS(sig);
    // viem's signMessage already produces low-s, so the normalized
    // form should equal the original (lowercased). Build a high-s
    // twin by reflecting and confirm the twin normalizes back.
    const SECP256K1_N = BigInt(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    );
    const sigBody = sig.slice(2);
    const r = sigBody.slice(0, 64);
    const s = BigInt("0x" + sigBody.slice(64, 128));
    const v = parseInt(sigBody.slice(128, 130), 16);
    const highS = SECP256K1_N - s;
    const highSHex = highS.toString(16).padStart(64, "0");
    const highV = (v ^ 1).toString(16).padStart(2, "0");
    const twin = "0x" + r + highSHex + highV;
    expect(normalizeLowS(twin)).toBe(normalized);
  });
});
