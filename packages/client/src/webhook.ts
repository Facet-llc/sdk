// Subscriber-side webhook verification.
//
// Facet webhook deliveries carry `X-Facet-Signature: t=<unix>,v1=<hex_hmac>`
// (with optional Phase 4 `kid=<id>,v2=<ed25519>`). Every subscription
// holds a per-subscription HMAC secret that was revealed once at
// `POST /v1/subscribe_webhook`. This helper verifies the v1= HMAC —
// the field every subscriber gets for free — without pulling in a Node
// HTTP framework or the full Terminal source.
//
// Subscribers wanting Ed25519 origin verification (v2=) should reach
// for `@facet/response-verifier` directly and fetch the publisher's
// /.well-known/facet-keys.json bundle; that path is a superset of this
// one.

export interface VerifyWebhookOptions {
  /** Hex-encoded shared secret from `subscribe_webhook`'s response. */
  readonly secret: string;
  /** The raw delivery body as received (bytes on the wire, exactly). */
  readonly body: string;
  /** The `X-Facet-Signature` header value as received. */
  readonly signatureHeader: string;
  /** Defaults to 300s. Set to 0 to disable the freshness check. */
  readonly toleranceSeconds?: number;
  /** Defaults to `Date.now()/1000`. Test-only override. */
  readonly now?: () => number;
}

export type VerifyWebhookResult =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: "malformed" | "stale" | "mismatch" };

export async function verifyWebhookDelivery(
  opts: VerifyWebhookOptions,
): Promise<VerifyWebhookResult> {
  const parsed = parseFacetSignatureHeader(opts.signatureHeader);
  if (parsed === undefined) return { ok: false, reason: "malformed" };

  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.t) > tolerance) return { ok: false, reason: "stale" };
  }

  const expected = await computeWebhookHmac(opts.secret, opts.body, parsed.t);
  if (!constantTimeEqual(expected, parsed.v1)) return { ok: false, reason: "mismatch" };
  return { ok: true, timestamp: parsed.t };
}

async function computeWebhookHmac(secretHex: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return bytesToHex(new Uint8Array(sig));
}

interface ParsedFacetSignature {
  readonly t: number;
  readonly v1: string;
}

function parseFacetSignatureHeader(header: string): ParsedFacetSignature | undefined {
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) return undefined;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n)) return undefined;
      t = n;
    } else if (key === "v1") {
      v1 = value;
    }
    // kid= and v2= are part of Phase 4's Ed25519 field and intentionally
    // ignored here — this helper validates the HMAC path, which every
    // Terminal serves.
  }
  if (t === undefined || v1 === undefined) return undefined;
  return { t, v1 };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("webhook secret hex length must be even");
  // Explicit ArrayBuffer-backed view: Deno's strict type-check rejects
  // the implicit `Uint8Array<ArrayBufferLike>` form that `new Uint8Array(n)`
  // produces when handing it to crypto.subtle.importKey.
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
