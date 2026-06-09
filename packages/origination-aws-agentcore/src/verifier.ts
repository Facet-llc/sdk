// IssuerDirectVerifier — fallback FacetOriginationVerifier for x402-only
// flows where the agent has no upstream platform attestation. Returns
// `direct:<wallet-address>` derived from the inbound attestation string
// (which the Terminal sets to the agent's wallet address).
//
// This file previously also exported `AgentCoreOriginationVerifier`, a
// merchant-side verifier that consumed a hypothetical AgentCore-emitted
// JWT delivered via `X-Agent-Attestation`. We removed it after confirming
// against the canonical AWS Bedrock AgentCore SDK that AgentCore's
// documented agent→merchant rail is the x402 `X-PAYMENT` header (produced
// by `PaymentManager.generatePaymentHeader`), NOT a separate AgentCore
// JWT. AWS does not publish a JWKS endpoint for workload tokens at the URL
// our verifier assumed. AgentCore-originated agents now flow through the
// standard `@facet-llc/payment-adapter-x402-coinbase` path — same as any
// other x402 originator. AgentCore-specific orchestration lives in
// `payment-manager.ts` (an agent-side helper, not a verifier).

import type {
  AgentPrincipal,
  FacetOriginationVerifier,
  OriginationVerifierMetadata,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "@facet-llc/protocol";

const PACKAGE_VERSION = "0.2.0";

/** Strict character set + length cap for the raw attestation. Limits the
 *  unsanitized text that ends up in mission-brief logs + downstream alert
 *  text. */
export const ISSUER_DIRECT_RAW_RE = /^[a-zA-Z0-9:_\-]{1,256}$/;

/** Forbidden prefixes — reject raw attestations that spoof another
 *  verifier's namespace. Update this list when a new verifier is added to
 *  the project. */
export const FORBIDDEN_AID_PREFIXES: readonly string[] = [
  "agentcore:",
  "cdp:",
  "skyfire:",
  "direct:",
];

export class IssuerDirectVerifier implements FacetOriginationVerifier {
  public readonly metadata: OriginationVerifierMetadata = {
    id: "issuer/direct",
    display_name: "Unattested (x402 wallet only)",
    version: PACKAGE_VERSION,
    kind: "direct",
    issuer_url: null,
    verify_is_local: true,
    egress_allowlist: [],
  };

  async verify(input: VerifyAttestationInput): Promise<VerifyAttestationResult> {
    const wallet = input.raw_attestation.trim();
    if (wallet === "") {
      return rejected("malformed", "direct verifier requires a wallet address");
    }
    if (FORBIDDEN_AID_PREFIXES.some((p) => wallet.toLowerCase().startsWith(p))) {
      return rejected(
        "malformed",
        "direct attestation must not begin with another verifier's namespace prefix",
      );
    }
    if (!ISSUER_DIRECT_RAW_RE.test(wallet)) {
      return rejected(
        "malformed",
        "direct attestation must be ascii-printable alnum + : _ -, 1..256 chars",
      );
    }
    const principal: AgentPrincipal = {
      aid: `direct:${wallet}`,
      issuer: this.metadata.id,
      scopes: [],
      expires_at: null,
      issued_at: new Date().toISOString(),
      max_spend_amount: null,
      max_spend_currency: null,
      raw_claims: { wallet },
    };
    return { kind: "ok", principal };
  }

  async warmKeys(): Promise<void> {
    return;
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
