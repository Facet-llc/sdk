// CoinbaseCdpOriginationVerifier — FacetOriginationVerifier for Coinbase
// Developer Platform (CDP) AgentKit-provisioned agents.
//
// AgentKit agents are server-managed wallets issued by CDP. The agent
// proves its identity to a merchant by signing a canonical attestation
// envelope with its CDP wallet — the merchant verifies the ECDSA
// signature against the claimed wallet address using viem's
// `verifyMessage`. The CDP SDK itself (`@coinbase/cdp-sdk`) provides
// wallet management primitives (CdpClient, EvmAccount, signMessage) on
// the agent side; there is no merchant-side "verify a CDP-issued
// signature" call — wallet-bound ECDSA verification is the right
// primitive.
//
// Optionally, when CDP credentials are supplied, the verifier can also
// cross-check that the claimed wallet is a registered CDP account via
// `CdpClient.evm.getAccount`. This catches the case where an attacker
// generates their own EOA, signs an envelope with it, and claims to be
// a CDP-managed agent. Without credentials, the verifier accepts any
// validly-signed envelope and tags it as `cdp:<address>` — the
// merchant's per-issuer trust policy decides whether that's enough.

import type {
  AgentPrincipal,
  FacetOriginationVerifier,
  OriginationVerifierMetadata,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "@facet-llc/adapter";
import type { CdpClient } from "@coinbase/cdp-sdk";
import { verifyMessage, type Address, type Hex } from "viem";

const PACKAGE_VERSION = "0.2.0";

/** Cap raw_attestation length to bound the per-request memory-amp attack
 *  surface on parseEnvelope's base64 decode + JSON.parse. CDP envelopes
 *  are <1 KB; 8 KB is generous and consistent with the cap shared across
 *  the AgentCore verifier and the Terminal. */
const MAX_ATTESTATION_BYTES = 8192;

/** The canonical message-envelope shape the agent signs. Encoded as
 *  base64-JSON in the X-Agent-Attestation header. The agent populates
 *  every field; the verifier checks that `signature` is a valid
 *  ECDSA-recoverable signature over `canonicalMessage(envelope)` for
 *  `wallet`. */
export interface CdpAttestationEnvelope {
  /** EIP-55 checksummed (or lowercase) CDP wallet address. */
  readonly wallet: Address;
  /** UTC ISO-8601 — the moment the agent signed the envelope. */
  readonly issued_at: string;
  /** UTC ISO-8601 — when the envelope stops being acceptable. */
  readonly expires_at: string;
  /** REQUIRED: request-binding nonce. The
   *  Terminal sets this to the inbound `Idempotency-Key` or a similar
   *  value and passes `bind_to` to the verifier; the verifier checks
   *  they match. Previously optional, which let an attacker replay an
   *  envelope with an ECDSA-malleability-mutated signature across a
   *  different idempotency key. Empty / missing bind_to is now rejected
   *  as malformed. */
  readonly bind_to: string;
  /** Optional scopes the agent claims the CDP wallet is authorized for.
   *  Cannot be cryptographically verified at this layer — merchants
   *  should treat them as advisory unless they also cross-check against
   *  CDP via the optional CdpClient hook. */
  readonly scopes?: readonly string[];
  /** Hex signature over canonicalMessage(envelope). */
  readonly signature: Hex;
}

/** Build the canonical text the agent signs. Stable across versions;
 *  changing the format is a breaking change to every deployed AgentKit
 *  agent that signs Facet attestations.
 *
 *  The string is multi-line and avoids JSON canonicalization
 *  complexity. Fields are in fixed order. */
export function canonicalMessage(envelope: Omit<CdpAttestationEnvelope, "signature">): string {
  const lines = [
    "facet-cdp-attestation/v1",
    `wallet:${envelope.wallet.toLowerCase()}`,
    `issued_at:${envelope.issued_at}`,
    `expires_at:${envelope.expires_at}`,
    `bind_to:${envelope.bind_to}`,
    `scopes:${(envelope.scopes ?? []).join(",")}`,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay cache for signed envelopes
// ─────────────────────────────────────────────────────────────────────────────

/** Pluggable replay cache. The verifier records every
 *  successfully-verified envelope's (wallet, low-s-normalized signature)
 *  tuple here; a duplicate hit short-circuits with a binding_mismatch
 *  rejection. In production, wire this to a durable shared store that
 *  survives Terminal restarts. The default in-memory store is fine for
 *  single-instance Terminals and all tests. */
export interface ReplayCache {
  /** Returns true if the key is already present (replay detected). */
  has(key: string): boolean | Promise<boolean>;
  /** Records the key with a TTL (ms). */
  add(key: string, ttlMs: number): void | Promise<void>;
}

/** In-memory replay cache with TTL eviction. Acceptable for single-
 *  instance Terminals; distributed Terminals SHOULD inject a
 *  Redis-backed implementation so a captured envelope can't replay
 *  against a different instance. */
export class InMemoryReplayCache implements ReplayCache {
  private readonly store = new Map<string, number>(); // key → expires-at ms
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  has(key: string): boolean {
    const expiresAt = this.store.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, ttlMs: number): void {
    // Opportunistic eviction — keep the Map from growing unboundedly
    // when long-running Terminals see millions of envelopes. Sweep
    // only when the size crosses a small threshold so the hot path
    // stays O(1).
    if (this.store.size > 1024) {
      const now = this.now();
      for (const [k, exp] of this.store) {
        if (exp <= now) this.store.delete(k);
      }
    }
    this.store.set(key, this.now() + ttlMs);
  }
}

// secp256k1 curve order, used to fold a high-s ECDSA signature down
// to its low-s canonical form per BIP-0146. Both forms verify against
// the same message, so without normalization an attacker can replay a
// captured signature in its mutated twin form. We treat (wallet, low-s
// signature) as the replay-cache key so both variants collapse.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/** Low-s-normalize an ECDSA signature in 65-byte (r ‖ s ‖ v) hex form.
 *  If `s > n/2`, replaces `s` with `n - s` and flips the recovery byte
 *  parity. Returns the input verbatim if the hex doesn't look like a
 *  65-byte secp256k1 signature (defensive — the verifier rejects those
 *  on the signature-verify path). */
export function normalizeLowS(signatureHex: string): string {
  const trimmed = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  if (trimmed.length !== 130) return signatureHex.toLowerCase();
  const rHex = trimmed.slice(0, 64);
  const sHex = trimmed.slice(64, 128);
  const vHex = trimmed.slice(128, 130);
  const sValue = BigInt("0x" + sHex);
  if (sValue <= SECP256K1_HALF_N) {
    // already canonical low-s
    return ("0x" + trimmed).toLowerCase();
  }
  const newS = SECP256K1_N - sValue;
  const newSHex = newS.toString(16).padStart(64, "0");
  // Flip v parity. Ethereum v = 27 + recovery_id, where recovery_id ∈
  // {0, 1}. To swap recovery_id you swap 27 ↔ 28. For modern viem
  // EIP-1559 signatures that use v ∈ {0, 1} directly, XOR-1 still
  // works. Anything else passes through (defensive — caller asked us
  // to normalize, so we do best-effort, but a non-standard v is
  // already on a deviant path).
  const vByte = parseInt(vHex, 16);
  const newVByte = vByte === 27 ? 28 : vByte === 28 ? 27 : vByte ^ 1;
  const newV = newVByte.toString(16).padStart(2, "0");
  return ("0x" + rHex + newSHex + newV).toLowerCase();
}

export interface CdpVerifierConfig {
  /** Clock-skew tolerance for expires_at in seconds. Default 30. */
  readonly clockToleranceSeconds?: number;
  /** Maximum age of the envelope (now - issued_at). Default 600s. */
  readonly maxEnvelopeAgeSeconds?: number;
  /** Optional CDP client. When provided, the verifier additionally
   *  calls `cdpClient.evm.getAccount({ address })` to confirm the
   *  wallet is a registered CDP-managed account, not an arbitrary EOA
   *  claiming the `cdp:` prefix. */
  readonly cdpClient?: CdpClient;
  /** Pluggable replay cache. Default is an InMemoryReplayCache scoped to
   *  this verifier instance — fine for single-instance Terminals and
   *  tests. Distributed Terminals SHOULD inject a durable shared
   *  implementation so a captured envelope can't replay against another
   *  instance. */
  readonly replayCache?: ReplayCache;
  /** Override `Date.now()` for tests. */
  readonly now?: () => number;
}

export class CoinbaseCdpOriginationVerifier implements FacetOriginationVerifier {
  public readonly metadata: OriginationVerifierMetadata;

  private readonly clockToleranceSeconds: number;
  private readonly maxEnvelopeAgeSeconds: number;
  private readonly cdpClient: CdpClient | undefined;
  private readonly replayCache: ReplayCache;
  private readonly now: () => number;

  constructor(cfg: CdpVerifierConfig = {}) {
    this.clockToleranceSeconds = cfg.clockToleranceSeconds ?? 30;
    this.maxEnvelopeAgeSeconds = cfg.maxEnvelopeAgeSeconds ?? 600;
    this.cdpClient = cfg.cdpClient;
    this.now = cfg.now ?? (() => Date.now());
    this.replayCache = cfg.replayCache ?? new InMemoryReplayCache(this.now);

    const usesNetwork = this.cdpClient !== undefined;
    this.metadata = {
      id: "issuer/coinbase-cdp",
      display_name: "Coinbase Developer Platform AgentKit",
      version: PACKAGE_VERSION,
      kind: "voucher",
      issuer_url: usesNetwork ? "https://api.developer.coinbase.com" : null,
      verify_is_local: !usesNetwork,
      egress_allowlist: usesNetwork ? ["https://api.developer.coinbase.com"] : [],
    };
  }

  async verify(input: VerifyAttestationInput): Promise<VerifyAttestationResult> {
    // Cap raw_attestation size before any base64/JSON decode in
    // parseEnvelope. Returning `malformed` keeps the memory-amp DoS
    // window tight without touching the parser.
    if (
      typeof input.raw_attestation === "string" &&
      input.raw_attestation.length > MAX_ATTESTATION_BYTES
    ) {
      return rejected("malformed", "X-Agent-Attestation envelope exceeds size cap");
    }
    const parsed = parseEnvelope(input.raw_attestation);
    if (parsed.kind === "error") {
      return rejected("malformed", parsed.reason);
    }
    const envelope = parsed.envelope;

    const nowMs = this.now();
    const issuedAtMs = Date.parse(envelope.issued_at);
    const expiresAtMs = Date.parse(envelope.expires_at);
    if (!Number.isFinite(issuedAtMs)) {
      return rejected("malformed", "issued_at is not a valid ISO timestamp");
    }
    if (!Number.isFinite(expiresAtMs)) {
      return rejected("malformed", "expires_at is not a valid ISO timestamp");
    }
    const skewMs = this.clockToleranceSeconds * 1000;
    if (nowMs > expiresAtMs + skewMs) {
      return rejected("expired", "envelope expired");
    }
    if (issuedAtMs > nowMs + skewMs) {
      return rejected("not_yet_valid", "issued_at is in the future");
    }
    if (nowMs - issuedAtMs > this.maxEnvelopeAgeSeconds * 1000 + skewMs) {
      return rejected(
        "expired",
        `envelope older than maxEnvelopeAgeSeconds (${this.maxEnvelopeAgeSeconds}s)`,
      );
    }

    if (input.bind_to !== undefined && envelope.bind_to !== input.bind_to) {
      return rejected("binding_mismatch", "envelope bind_to does not match request bind_to");
    }

    let signatureValid: boolean;
    try {
      signatureValid = await verifyMessage({
        address: envelope.wallet,
        message: canonicalMessage(envelope),
        signature: envelope.signature,
      });
    } catch (e) {
      return rejected(
        "signature_invalid",
        `signature verification threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!signatureValid) {
      return rejected("signature_invalid", "signature did not recover claimed wallet");
    }

    // Server-side replay-cache check after signature verification
    // passes. Key = (lowercased wallet,
    // low-s-normalized signature) — folding to low-s means a captured
    // envelope's high-s twin collapses to the same key. TTL covers the
    // entire window an envelope could still verify against (envelope
    // age + clock skew on either side).
    const replayKey = `${envelope.wallet.toLowerCase()}|${normalizeLowS(envelope.signature)}`;
    const cacheTtlMs = (this.maxEnvelopeAgeSeconds + this.clockToleranceSeconds * 2) * 1000;
    if (await this.replayCache.has(replayKey)) {
      return rejected(
        "binding_mismatch",
        "envelope signature has already been used (replay detected)",
      );
    }

    if (this.cdpClient !== undefined) {
      const cdpCheck = await checkCdpRegistered(this.cdpClient, envelope.wallet);
      if (cdpCheck.kind === "rejected") return cdpCheck.result;
      // Fail-closed when cdpClient is configured. Previously a transient
      // CDP API error returned
      // `kind: 'error', retryable: true`, letting an attacker time
      // their dispatch against a CDP outage to bypass the registered-
      // wallet check. The merchant's opt-in to cdpClient means
      // "do not accept wallets I can't confirm are real CDP wallets" —
      // surface as a rejection, not a retryable infrastructure error.
      // Operators can disable the cross-check during a known CDP
      // outage if business continuity requires it.
      if (cdpCheck.kind === "error") return cdpCheck.result;
    }

    await this.replayCache.add(replayKey, cacheTtlMs);

    const principal: AgentPrincipal = {
      aid: `cdp:${envelope.wallet.toLowerCase()}`,
      issuer: this.metadata.id,
      scopes: envelope.scopes ?? [],
      expires_at: envelope.expires_at,
      issued_at: envelope.issued_at,
      max_spend_amount: null,
      max_spend_currency: null,
      raw_claims: envelope as unknown as Readonly<Record<string, unknown>>,
    };
    return { kind: "ok", principal };
  }

  async warmKeys(): Promise<void> {
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type ParseResult =
  { kind: "ok"; envelope: CdpAttestationEnvelope } | { kind: "error"; reason: string };

function parseEnvelope(raw: string): ParseResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { kind: "error", reason: "X-Agent-Attestation header is empty" };
  }
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return { kind: "error", reason: "attestation is not valid base64" };
  }
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    return { kind: "error", reason: "attestation is not valid JSON after base64 decode" };
  }
  if (typeof json !== "object" || json === null) {
    return { kind: "error", reason: "attestation must be a JSON object" };
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(obj.wallet)) {
    return { kind: "error", reason: "wallet must be a 0x-prefixed 20-byte address" };
  }
  if (typeof obj.issued_at !== "string") {
    return { kind: "error", reason: "issued_at must be a string" };
  }
  if (typeof obj.expires_at !== "string") {
    return { kind: "error", reason: "expires_at must be a string" };
  }
  if (typeof obj.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(obj.signature)) {
    return { kind: "error", reason: "signature must be a 0x-prefixed hex string" };
  }
  // bind_to is required and non-empty. A missing / empty bind_to would
  // nullify the verifier's only replay defense — the canonical message
  // is identical between an original and any ECDSA-malleability-twin
  // signature, and there is no nonce table to catch the duplicate.
  if (typeof obj.bind_to !== "string" || obj.bind_to.length === 0) {
    return {
      kind: "error",
      reason: "bind_to is required and must be a non-empty string",
    };
  }
  if (obj.scopes !== undefined) {
    if (!Array.isArray(obj.scopes) || obj.scopes.some((s: unknown) => typeof s !== "string")) {
      return { kind: "error", reason: "scopes must be an array of strings when present" };
    }
  }
  const envelope: CdpAttestationEnvelope = {
    wallet: obj.wallet as Address,
    issued_at: obj.issued_at,
    expires_at: obj.expires_at,
    signature: obj.signature as Hex,
    bind_to: obj.bind_to,
    ...(Array.isArray(obj.scopes) ? { scopes: obj.scopes as readonly string[] } : {}),
  };
  return { kind: "ok", envelope };
}

type CdpCheckResult =
  | { kind: "ok" }
  | { kind: "rejected"; result: VerifyAttestationResult }
  | { kind: "error"; result: VerifyAttestationResult };

async function checkCdpRegistered(client: CdpClient, address: Address): Promise<CdpCheckResult> {
  try {
    // CdpClient.evm.getAccount({ address }) returns the registered
    // account or throws if it isn't found. We only care about the
    // existence check; the returned account fields are unused.
    await client.evm.getAccount({ address });
    return { kind: "ok" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 404 / "not found" responses mean the wallet is not a registered
    // CDP account.
    if (/not\s*found|404/i.test(message)) {
      return {
        kind: "rejected",
        result: rejected(
          "issuer_unknown",
          "wallet is not registered with the CDP project (per CdpClient lookup)",
        ),
      };
    }
    // Fail-closed on transient CDP errors. Returning a retryable error
    // here would let an attacker time their
    // dispatch against a CDP outage to bypass the registered-wallet
    // check entirely. Surface as a rejection — merchants who opted in
    // to the cross-check did so to enforce the registered-wallet
    // invariant, not to silently fall back on the unattested path
    // during a CDP outage. The verifier's metadata.egress_allowlist
    // already declares the dependency so operators can drop the
    // cross-check if CDP is down and business continuity demands it.
    return {
      kind: "rejected",
      result: rejected(
        "issuer_unknown",
        `CDP lookup failed — wallet cannot be confirmed registered: ${message}`,
      ),
    };
  }
}

function rejected(
  reason:
    | "signature_invalid"
    | "issuer_unknown"
    | "expired"
    | "not_yet_valid"
    | "binding_mismatch"
    | "malformed"
    | "revoked",
  message: string,
): VerifyAttestationResult {
  return { kind: "rejected", reason, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helper — exported so agent-side libraries can build the
// header without redefining the envelope shape.
// ─────────────────────────────────────────────────────────────────────────────

export function encodeAttestationHeader(envelope: CdpAttestationEnvelope): string {
  return btoa(JSON.stringify(envelope));
}
