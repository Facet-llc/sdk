// IssuerDirectVerifier tests — covers the char-set + namespace-
// prefix sanitization that prevents an attacker from stuffing arbitrary
// bytes into the unsanitized aid (which lands in mission-brief logs +
// downstream alert text).
//
// AgentCoreOriginationVerifier tests were removed on 2026-05-25 — the
// class itself was removed because the canonical AWS Bedrock AgentCore
// SDK does not expose the merchant-side JWT-attestation flow it
// assumed. See `packages/origination-aws-agentcore/src/verifier.ts` for
// the audit notes, and `test/payment-manager.test.ts` for the spec-
// faithful PaymentManager TS port that replaces it.

import { describe, expect, it } from "vitest";

import { IssuerDirectVerifier } from "../src/verifier.ts";

describe("IssuerDirectVerifier", () => {
  it("returns direct:<wallet> for a non-empty attestation", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      trace_id: "t",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.principal.aid).toBe("direct:0x71C7656EC7ab88b098defB751B7401B5f6d8976F");
      expect(result.principal.issuer).toBe("issuer/direct");
    }
  });

  it("rejects an empty attestation", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({ raw_attestation: "  ", trace_id: "t" });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("malformed");
  });

  it("declares the direct metadata invariants", () => {
    const v = new IssuerDirectVerifier();
    expect(v.metadata.kind).toBe("direct");
    expect(v.metadata.verify_is_local).toBe(true);
    expect(v.metadata.issuer_url).toBeNull();
    expect(v.metadata.egress_allowlist).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // �� char-set + namespace-prefix sanitization
  // ───────────────────────────────────────────────────────────────────────

  it("rejects raw_attestation with non-printable / non-allowed chars (newline)", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "wallet\n[ALERT] fake",
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("malformed");
    }
  });

  it("rejects raw_attestation containing JSON-breaking quote", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: `0xabc"}, {"fake":"injected`,
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects raw_attestation longer than 256 chars", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "a".repeat(257),
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects raw_attestation starting with agentcore: prefix", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "agentcore:arn:aws:iam::123:role/admin",
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.message).toContain("namespace prefix");
    }
  });

  it("rejects raw_attestation starting with cdp: prefix", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "cdp:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects raw_attestation starting with direct: prefix (double-namespacing)", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "direct:0xabc",
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
  });

  it("prefix check is case-insensitive (rejects AGENTCORE:)", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "AGENTCORE:0xabc",
      trace_id: "t",
    });
    expect(result.kind).toBe("rejected");
  });

  it("accepts a clean EIP-55 wallet address (regression)", async () => {
    const v = new IssuerDirectVerifier();
    const result = await v.verify({
      raw_attestation: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      trace_id: "t",
    });
    expect(result.kind).toBe("ok");
  });
});
