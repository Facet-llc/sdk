import { describe, expect, it } from "vitest";
import { verifyWebhookDelivery } from "../src/webhook.ts";

// A fixed hex secret + body pair lets us pin exact signatures.
const SECRET = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const BODY = JSON.stringify({ event: "order.settled", data: { order_id: "ord-abc" } });

async function signHmac(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("verifyWebhookDelivery", () => {
  it("accepts a freshly signed v1= HMAC", async () => {
    const t = 1_700_000_000;
    const v1 = await signHmac(SECRET, BODY, t);
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: `t=${t},v1=${v1}`,
      now: () => t,
    });
    expect(result).toEqual({ ok: true, timestamp: t });
  });

  it("ignores Phase 4 kid= and v2= fields and still verifies v1=", async () => {
    const t = 1_700_000_000;
    const v1 = await signHmac(SECRET, BODY, t);
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: `t=${t},v1=${v1},kid=key-2026-q1,v2=ignored-ed25519-sig`,
      now: () => t,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body with reason 'mismatch'", async () => {
    const t = 1_700_000_000;
    const v1 = await signHmac(SECRET, BODY, t);
    const tampered = BODY.replace("ord-abc", "ord-xyz");
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: tampered,
      signatureHeader: `t=${t},v1=${v1}`,
      now: () => t,
    });
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const signedAt = 1_700_000_000;
    const v1 = await signHmac(SECRET, BODY, signedAt);
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: `t=${signedAt},v1=${v1}`,
      now: () => signedAt + 3600, // 1 hour later
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("skips the freshness check when toleranceSeconds=0 (replay tests)", async () => {
    const signedAt = 1_700_000_000;
    const v1 = await signHmac(SECRET, BODY, signedAt);
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: `t=${signedAt},v1=${v1}`,
      now: () => signedAt + 86_400, // one day later
      toleranceSeconds: 0,
    });
    expect(result).toEqual({ ok: true, timestamp: signedAt });
  });

  it("rejects a malformed header with reason 'malformed'", async () => {
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: "not-a-valid-signature",
      now: () => 1_700_000_000,
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a header missing v1=", async () => {
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: "t=1700000000",
      now: () => 1_700_000_000,
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a header with non-numeric t=", async () => {
    const result = await verifyWebhookDelivery({
      secret: SECRET,
      body: BODY,
      signatureHeader: "t=abc,v1=deadbeef",
      now: () => 1_700_000_000,
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});
