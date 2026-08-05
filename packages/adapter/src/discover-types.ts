// @facet-llc/adapter — Universal Business Index discovery types.
//
// Wire-contract types for POST /v1/discover, the public UBI discovery
// surface. An arriving agent searches the Universal Business Index by
// natural-language query, geo center + radius, NAICS / facet_taxonomy
// filters, a one-hop kg_edges relationship, a reputation floor, and a
// claimed-only flag — and gets back ranked listings, each carrying the
// business's Terminal URL so discoverAndConnect resolves in one hop.
//
// All ranking + SAFE-column projection happens server-side in the
// public.facet_discover RPC (security-definer); these types describe the
// JSON the Terminal accepts and returns. Field names are snake_case on the
// wire and preserved verbatim.

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/discover — request
// ─────────────────────────────────────────────────────────────────────────────

/** Geographic search center. When present, results carry a distance_m and
 *  proximity feeds the ranking; absent ⇒ distance_m is null and proximity is
 *  dropped from the rank. */
export interface DiscoverNear {
  readonly lat: number;
  readonly lng: number;
}

/** One-hop knowledge-graph relationship filter: return businesses one
 *  kg_edges hop away from `connected_to` (a ubi_id), optionally constrained
 *  to a single edge `relation`. */
export interface DiscoverEdge {
  readonly connected_to: string;
  readonly relation?: string;
}

export interface DiscoverRequest {
  /** NL / keyword search over business name (+ facet_taxonomy text match). */
  readonly query?: string;
  /** Geo search center; pairs with `radius_km`. */
  readonly near?: DiscoverNear;
  /** Search radius in kilometers (only applied when `near` is given). */
  readonly radius_km?: number;
  /** Match universal_business_index.naics = ANY of these. */
  readonly naics?: readonly number[];
  /** facet_taxonomy overlap (&&) filter. */
  readonly taxonomy?: readonly string[];
  /** Capability tags; folded into the facet_taxonomy overlap filter. */
  readonly capabilities?: readonly string[];
  /** One-hop kg_edges relationship filter. */
  readonly edge?: DiscoverEdge;
  /** Minimum mv_ubi_facet_score.avg_score. */
  readonly min_reputation?: number;
  /** Only return businesses with a claimed site. */
  readonly claimed_only?: boolean;
  /** Page size (default 20, capped server-side at 50). */
  readonly limit?: number;
  /** Page offset (default 0). */
  readonly offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/discover — response
// ─────────────────────────────────────────────────────────────────────────────

/** Aggregate reputation projection for a discovered business. */
export interface DiscoverReputation {
  readonly avg_score: number | null;
  readonly total_interactions: number;
}

/** Human/agent handoff affordances for a discovered business. */
export interface DiscoverHandoff {
  readonly phone: string | null;
  /** `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`. */
  readonly directions_url: string | null;
}

/** A single ranked listing. SAFE columns only — no internal identifiers
 *  beyond the public ubi_id, the claimed site's domain/handle, and the
 *  fields below. */
export interface DiscoverResult {
  readonly ubi_id: string;
  readonly name: string;
  /** Present and `true` only on entries returned in the `featured` array
   *  (the facet_discover RPC stamps `featured: true` on those objects).
   *  Absent on entries in `results`. */
  readonly featured?: boolean;
  /** Formatted single-line address from address_jsonb. */
  readonly address: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  /** Great-circle distance from the search center, or null with no geo center. */
  readonly distance_m: number | null;
  readonly naics: number | null;
  /** facet_taxonomy tags. */
  readonly taxonomy: readonly string[];
  readonly claim_status: string;
  readonly reputation: DiscoverReputation;
  /** The business's Terminal entry point. CLAIMED + live →
   *  `https://<domain|terminal.facet.llc>/v1`; CLAIMED + pre-live →
   *  `https://<handle>.sandbox.facet.llc/v1`; UNCLAIMED → null. */
  readonly terminal_url: string | null;
  /** Declared capabilities from the claimed site, or null. */
  readonly capabilities: readonly string[] | null;
  readonly handoff: DiscoverHandoff;
}

export interface DiscoverResponse {
  /** Featured (sponsored / top-ranked) listings, surfaced ahead of the
   *  ranked page. The facet_discover RPC always returns this array (possibly
   *  empty) and stamps `featured: true` on each entry; a discovery client
   *  should read `featured` first, then `results`. */
  readonly featured: readonly DiscoverResult[];
  readonly results: readonly DiscoverResult[];
  /** Estimated total matches across all pages (for paging UIs). */
  readonly total_estimate: number;
  /** Offset to pass for the next page, or null when exhausted. */
  readonly next_offset: number | null;
}
