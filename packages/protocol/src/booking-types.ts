// @facet-llc/protocol — Booking primitive wire-contract types.
//
// Wire-contract types for the booking primitive, authored in the
// protocol package so SDK consumers + the OpenAPI generator can import
// them.
//
// Five Terminal routes share these types:
//   POST /v1/find_slots
//   POST /v1/hold_slot
//   POST /v1/confirm_booking
//   POST /v1/modify_booking
//   POST /v1/cancel_booking
//
// The adapter-side result types (AdapterSlot, HoldSlotResult, etc.)
// are re-exported here so callers don't need to depend on
// @facet-llc/schema-generator-core just to type a Terminal response.

// ─────────────────────────────────────────────────────────────────────────────
// Adapter-side result shapes — wire-shape parity with the booking
// adapter types, kept in sync by a contract drift check.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterSlot {
  /** Provider-specific slot identifier (e.g., Calendly event_type slot URI). */
  readonly external_slot_id: string;
  readonly start_at: string; // ISO 8601
  readonly end_at: string;
  readonly capacity_total: number;
  readonly capacity_remaining: number;
}

export interface HoldSlotResult {
  readonly hold_token: string;
  readonly hold_expires_at: string; // ISO 8601
}

export interface ConfirmBookingResult {
  readonly external_booking_id: string;
  readonly confirmation_code: string;
  readonly start_at: string;
  readonly end_at: string;
}

export interface ModifyBookingResult {
  readonly external_booking_id: string; // adapter MAY mint a new id
  readonly start_at: string;
  readonly end_at: string;
}

export interface CancelBookingResult {
  readonly cancelled_at: string;
  readonly refund_eligible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/** ISO 8601 date or datetime range used by both find_slots and find_inventory. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** Attendee details captured at confirm_booking. All fields optional —
 *  some providers (Calendly) collect them post-confirm via the
 *  scheduling-link form; the Terminal still records what's known. */
export interface BookingAttendee {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/find_slots
// ─────────────────────────────────────────────────────────────────────────────

export interface FindSlotsRequest {
  readonly resource_id: string;
  readonly date_range: DateRange;
  readonly party_size?: number;
  readonly limit?: number;
}

export interface FindSlotsResponse {
  readonly slots: readonly AdapterSlot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/hold_slot
// ─────────────────────────────────────────────────────────────────────────────

export interface HoldSlotRequest {
  readonly resource_id: string;
  readonly slot_id: string;
  readonly hold_seconds?: number;
}

export type HoldSlotResponse = HoldSlotResult;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/confirm_booking
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmBookingRequest {
  readonly resource_id: string;
  readonly slot_id: string;
  readonly hold_token: string;
  readonly attendee: BookingAttendee;
  /** KYAPay charge id when the agent paid a deposit. */
  readonly deposit_kya_charge_id?: string;
  readonly notes?: string;
}

export type ConfirmBookingResponse = ConfirmBookingResult;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/modify_booking
// ─────────────────────────────────────────────────────────────────────────────

export interface ModifyBookingRequest {
  readonly resource_id: string;
  readonly booking_id: string;
  readonly new_slot_id: string;
  readonly hold_token: string;
}

export type ModifyBookingResponse = ModifyBookingResult;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/cancel_booking
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelBookingRequest {
  readonly resource_id: string;
  readonly booking_id: string;
  readonly reason?: string;
}

export type CancelBookingResponse = CancelBookingResult;
