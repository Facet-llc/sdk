// @facet-llc/protocol — Auction primitive wire-contract types.
//
// Wire-contract types for the auction primitive, authored in the
// protocol package as the canonical source.
//
// Four Terminal routes share these types:
//   POST /v1/list_auctions
//   POST /v1/get_auction
//   POST /v1/place_bid
//   POST /v1/get_bid_status
//
// `AuctionRow` is the full database projection (including the
// privacy-sensitive `current_bidder_aid`). `PublicAuction` is the
// projection agents receive over the wire — bidder identity is
// masked behind `has_high_bidder`.

// ─────────────────────────────────────────────────────────────────────────────
// Core resource shapes
// ─────────────────────────────────────────────────────────────────────────────

export type AuctionStatus = "scheduled" | "live" | "ended_sold" | "ended_no_sale";

/** Full auction row as stored in the auctions table. Includes
 *  `current_bidder_aid` which is NOT exposed to non-owners on the
 *  wire — agents see `PublicAuction` (below). Kept exported because
 *  some Terminal-side dispatch code (place_bid → assert site, etc.)
 *  needs the full shape. */
export interface AuctionRow {
  readonly id: string;
  readonly site_id: string;
  readonly item_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly reserve_price_minor: number | null;
  readonly starting_price_minor: number;
  readonly bid_increment_minor: number;
  readonly currency: string;
  readonly auction_style: string;
  readonly anti_sniping_extension_sec: number;
  readonly current_price_minor: number;
  readonly current_max_bid_minor: number | null;
  readonly current_bidder_aid: string | null;
  readonly bid_count: number;
  readonly status: AuctionStatus | string;
  readonly winning_order_id: string | null;
  readonly metadata_jsonb: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  /** Handler-computed (ends_at - now) bucket. */
  readonly ends_in_sec: number;
}

/** Public projection — strips `current_bidder_aid`, replaces it with
 *  a boolean. */
export type PublicAuction = Omit<AuctionRow, "current_bidder_aid"> & {
  readonly has_high_bidder: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/list_auctions
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAuctionsRequest {
  readonly site_id?: string;
  readonly status?: AuctionStatus;
  readonly ends_within_hours?: number;
  readonly limit?: number;
}

export interface ListAuctionsResponse {
  readonly auctions: readonly PublicAuction[];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/get_auction
// ─────────────────────────────────────────────────────────────────────────────

export interface GetAuctionRequest {
  readonly auction_id: string;
}

export interface GetAuctionResponse {
  /** PublicAuction augmented with a caller-specific reveal: whether
   *  the caller is currently the high bidder on this auction.
   *  Returned only on the per-auction read; not on list_auctions. */
  readonly auction: PublicAuction & { readonly caller_is_high_bidder: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/place_bid
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceBidRequest {
  readonly auction_id: string;
  readonly max_bid_minor: number;
}

export interface PlaceBidResponse {
  /** Numeric bid identifier. May move to a string-encoded form to
   *  dodge the JS safe-integer ceiling at scale. */
  readonly bid_id: number;
  readonly amount_minor: number;
  readonly was_outbid_immediately: boolean;
  readonly is_high_bidder: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/get_bid_status
// ─────────────────────────────────────────────────────────────────────────────

export interface BidSummary {
  /** Database serial — see B3 caveat on PlaceBidResponse.bid_id. */
  readonly id: number;
  readonly amount_minor: number;
  readonly max_bid_minor: number;
  readonly was_winning: boolean;
  readonly placed_at: string;
}

export interface GetBidStatusRequest {
  readonly auction_id: string;
}

export interface GetBidStatusResponse {
  readonly bid_count: number;
  readonly bids: readonly BidSummary[];
  readonly is_high_bidder: boolean;
}
