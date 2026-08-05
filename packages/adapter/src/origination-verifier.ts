// @facet-llc/adapter — Agent origination attestation verifier.
//
// Orthogonal to the settlement rail (see rail-adapter.ts). An origination
// verifier proves WHO the agent is and WHICH PLATFORM provisioned it —
// before the Terminal accepts any payment authority from it.
//
// Inbound flow:
//   1. Agent sends `X-Agent-Attestation: <token>` plus `X-PAYMENT: <…>`.
//   2. Terminal picks an origination verifier by inspecting the token's
//      issuer claim (JWT `iss`, voucher `issuer`, …) and matching it to
//      a registered verifier's `id`.
//   3. Terminal calls verify() and gets back an AgentPrincipal.
//   4. Terminal applies the merchant's per-issuer policy (allow/deny,
//      scope requirements, max spend per session).
//   5. Terminal then delegates settlement to the rail adapter, passing
//      the AgentPrincipal so the adapter can include it in audit logs.
//
// Verifiers are pluggable so a merchant can opt in to:
//   - issuer/aws-agentcore   — AgentCore PaymentManager-signed JWTs
//   - issuer/coinbase-cdp    — CDP-issued AgentKit credentials
//   - issuer/skyfire         — Skyfire voucher signatures
//   - issuer/direct          — no attestation, agent presents only the
//                              x402 signature (lowest trust tier)
//   - issuer/<custom>        — merchants can register their own

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** Stable verifier identifier, namespaced under `issuer/`. */
export type OriginationVerifierId = string;

export type AttestationKind =
  /** Standard JWT signed by the issuer. JWKS fetched from
   *  `issuer_url + /.well-known/jwks.json`. */
  | "jwt"
  /** Detached signature over a canonical message envelope. Used by
   *  voucher-style issuers (Skyfire). */
  | "voucher"
  /** HMAC of a request body with a pre-shared key. Used for
   *  low-stakes / internal scenarios. */
  | "hmac"
  /** No attestation. The verifier accepts everything and tags the
   *  resulting principal as `attestation_kind: "direct"`. */
  | "direct";

export interface OriginationVerifierMetadata {
  readonly id: OriginationVerifierId;
  readonly display_name: string;
  readonly version: string;
  readonly kind: AttestationKind;
  /** Issuer base URL — used for JWKS discovery and as the canonical
   *  `iss` claim value for JWT verifiers. Null for `direct`. */
  readonly issuer_url: string | null;
  /** True iff verify() can be called without any network egress
   *  (e.g., HMAC verifiers with pre-loaded keys). The Terminal uses
   *  this to short-circuit hot-path latency. */
  readonly verify_is_local: boolean;
  /** Outbound destinations the verifier needs at runtime (typically
   *  the JWKS endpoint). */
  readonly egress_allowlist: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify input + result
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyAttestationInput {
  /** The raw value of the X-Agent-Attestation header (or whatever
   *  transport the attestation arrived on). The verifier is responsible
   *  for parsing per its `kind`. */
  readonly raw_attestation: string;
  /** Trace ID for correlation; not used in verification. */
  readonly trace_id: string;
  /** Optional binding context — the verifier can require the
   *  attestation to be bound to this specific Terminal request
   *  (replay protection). Typically the request body hash or
   *  `idempotency_key`. */
  readonly bind_to?: string;
}

/** The verified principal — what the rest of the Terminal handler sees
 *  for "who is this agent". */
export interface AgentPrincipal {
  /** Globally-unique agent identifier — the verifier's namespace
   *  prefix plus the issuer's local agent id.
   *  Examples:
   *    - "agentcore:arn:aws:bedrock:us-east-1:123456789012:agent/MyAgent"
   *    - "cdp:0x71C7…1234"
   *    - "skyfire:vch_01H…"
   *    - "direct:0x71C7…1234" (just the wallet address) */
  readonly aid: string;
  /** Matches `OriginationVerifierMetadata.id`. */
  readonly issuer: OriginationVerifierId;
  /** Scopes the issuer granted to this agent. Merchant policy decides
   *  which scopes are required to transact. */
  readonly scopes: readonly string[];
  /** UTC ISO-8601 — when the attestation expires. Null for
   *  non-expiring credentials. */
  readonly expires_at: string | null;
  /** UTC ISO-8601 — when the issuer reports the agent was created.
   *  Merchants can use this to gate new agents (anti-fraud). */
  readonly issued_at: string;
  /** The end-user (if any) on whose behalf the agent is acting.
   *  Populated when the issuer's protocol carries delegation info
   *  (AgentCore session has user identity; raw x402 wallet does not). */
  readonly acting_for?: string;
  /** Maximum spend the issuer authorized for this attestation in
   *  smallest currency unit. Null = unlimited within the attestation
   *  lifetime. The Terminal enforces this. */
  readonly max_spend_amount: number | null;
  readonly max_spend_currency: string | null;
  /** Verifier-side raw claims for forensics. Opaque to the Terminal. */
  readonly raw_claims: Readonly<Record<string, unknown>>;
}

export type VerifyAttestationResult =
  | { readonly kind: "ok"; readonly principal: AgentPrincipal }
  | {
      readonly kind: "rejected";
      /** One of:
       *    - "signature_invalid"
       *    - "issuer_unknown"
       *    - "expired"
       *    - "not_yet_valid"
       *    - "binding_mismatch"
       *    - "malformed"
       *    - "revoked"        (issuer published a revocation list hit) */
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      /** Transient verifier infrastructure failure (JWKS fetch failed,
       *  etc.). The Terminal should retry. */
      readonly message: string;
      readonly retryable: true;
    };

// ─────────────────────────────────────────────────────────────────────────────
// The verifier interface itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface FacetOriginationVerifier {
  readonly metadata: OriginationVerifierMetadata;

  /** Verify an attestation and return the agent principal. */
  verify(input: VerifyAttestationInput): Promise<VerifyAttestationResult>;

  /** Pre-fetch and cache the issuer's verification material (JWKS,
   *  voucher signing keys). Called by the Terminal at startup and
   *  on a refresh interval. Implementations MAY no-op if the verifier
   *  fetches lazily, but SHOULD warm the cache to avoid hot-path
   *  latency on first request. */
  warmKeys(): Promise<void>;
}
