// @facet-llc/protocol — RFQ primitive wire-contract types.
//
// Wire-contract types for the RFQ primitive, authored in the protocol
// package as the canonical source.
//
// Five Terminal routes share these types:
//   POST /v1/submit_rfq
//   POST /v1/get_rfq_status
//   POST /v1/accept_quote
//   POST /v1/counter_quote
//   POST /v1/cancel_rfq
//
// The wire shape and the Terminal's internal RFQ types are kept in
// sync by a contract drift check.

// ─────────────────────────────────────────────────────────────────────────────
// Core resource shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Status of an RFQ request. The wire enum stays open today rather than
 *  being strictly enforced end-to-end; treat unknown values
 *  defensively. */
export type RfqRequestStatus =
  | "open"
  | "quoted"
  | "countered"
  | "accepted"
  | "cancelled"
  | "expired";

/** Status of an individual quote within an RFQ. */
export type RfqQuoteStatus = "live" | "accepted" | "rejected" | "expired" | "superseded";

/** Spec-attached file. Subset of the handler-side validated attachment
 *  — only fields that survive the validation pass to land on the
 *  wire. */
export interface RfqAttachment {
  readonly url: string;
  readonly label?: string;
  readonly mime?: string;
  readonly size?: number;
  readonly kind?: string;
}

export interface RfqRequest {
  readonly id: string;
  readonly site_id: string;
  readonly agent_aid: string;
  readonly spec_jsonb: Readonly<Record<string, unknown>>;
  readonly attachments_jsonb: readonly RfqAttachment[];
  readonly status: RfqRequestStatus;
  readonly needed_by: string | null;
  readonly expires_at: string | null;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RfqQuote {
  readonly id: string;
  readonly request_id: string;
  readonly site_id: string;
  readonly issued_by_user: string;
  readonly price_minor: number;
  readonly currency: string;
  readonly lead_time_days: number | null;
  readonly terms_jsonb: Readonly<Record<string, unknown>>;
  readonly valid_until: string;
  readonly status: RfqQuoteStatus;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/submit_rfq
// ─────────────────────────────────────────────────────────────────────────────

export interface SubmitRfqRequest {
  readonly site_id: string;
  /** Free-form spec payload (capped at 100 KB by the Terminal). */
  readonly spec: Readonly<Record<string, unknown>>;
  /** Up to 10 attachments, 10 MB each, 50 MB total (Terminal caps). */
  readonly attachments?: readonly RfqAttachment[];
  readonly needed_by?: string; // ISO 8601
  readonly expires_at?: string; // ISO 8601
  readonly notes?: string;
}

export interface SubmitRfqResponse {
  readonly request: RfqRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/get_rfq_status
// ─────────────────────────────────────────────────────────────────────────────

export interface GetRfqStatusRequest {
  readonly request_id: string;
}

export interface GetRfqStatusResponse {
  readonly request: RfqRequest;
  readonly quotes: readonly RfqQuote[];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/accept_quote
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptQuoteRequest {
  readonly request_id: string;
  readonly quote_id: string;
}

export interface AcceptQuoteResponse {
  readonly request: RfqRequest;
  readonly quote: RfqQuote;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/counter_quote
// ─────────────────────────────────────────────────────────────────────────────

export interface CounterQuoteRequest {
  readonly request_id: string;
  /** Quote being countered. Omit when posting a counter to the supplier's
   *  silence (no specific quote selected). */
  readonly quote_id?: string;
  readonly body: string;
  readonly counter_terms?: Readonly<Record<string, unknown>>;
}

export interface CounterQuoteResponse {
  /** Numeric message identifier. May move to a string-encoded form to
   *  dodge the JS safe-integer ceiling at scale. */
  readonly message_id: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/cancel_rfq
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelRfqRequest {
  readonly request_id: string;
  readonly reason?: string;
}

export interface CancelRfqResponse {
  readonly request: RfqRequest;
}
