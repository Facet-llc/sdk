// @facet-llc/adapter — Domain verification types.
//
// Wire-contract types for domain verification, authored in the protocol
// package. Single Terminal route:
//   POST /v1/verify_domain
//
// `VerifyDomainOutcome` is the handler-side discriminated union (kept
// for symmetry with the internal verifier); `VerifyDomainResponse` is
// the flattened wire shape the handler emits.

export type VerificationMethod = "well-known" | "dns";

// ─────────────────────────────────────────────────────────────────────────────
// Handler-side discriminated union (mirror of domain-verify.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyDomainOutcome =
  | {
      readonly kind: "verified";
      readonly site_id: string;
      readonly method: VerificationMethod;
      readonly verified_at: string;
    }
  | { readonly kind: "site_not_found" }
  | { readonly kind: "no_token_issued" }
  | {
      readonly kind: "mismatch";
      readonly method: VerificationMethod;
      readonly found: string | null;
      readonly expected_hint: string;
    }
  | {
      readonly kind: "fetch_failed";
      readonly method: VerificationMethod;
      readonly reason: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/verify_domain — wire types
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyDomainRequest {
  readonly site_id: string;
  readonly method: VerificationMethod;
}

/** Wire-shape response — a flattened version of `VerifyDomainOutcome`
 *  that splits the discriminated union on the boolean `verified` field.
 *  Failure modes that surface as FacetError (site_not_found,
 *  no_token_issued) do NOT reach this response — they raise instead. */
export type VerifyDomainResponse =
  | {
      readonly verified: true;
      readonly site_id: string;
      readonly method: VerificationMethod;
      readonly verified_at: string;
    }
  | {
      readonly verified: false;
      readonly reason: "mismatch" | "fetch_failed";
      readonly method: VerificationMethod;
      readonly hint: string;
      readonly found?: string;
    };
