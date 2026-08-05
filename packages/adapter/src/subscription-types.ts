// @facet-llc/adapter — Subscription primitive wire-contract types.
//
// Wire-contract types for the subscription primitive, authored in the
// protocol package as the canonical source.
//
// Five Terminal routes share these types:
//   POST /v1/create_subscription
//   POST /v1/pause_subscription
//   POST /v1/skip_next_run
//   POST /v1/cancel_subscription
//   POST /v1/modify_subscription_lines
//
// Plus the date-bound inventory route:
//   POST /v1/find_inventory
//
// The wire shape and the Terminal's internal subscription types are kept
// in sync by a contract drift check.

import type { DateRange } from "./booking-types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Subscription line items + profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionLineItem {
  readonly product_id: string;
  readonly qty: number;
  readonly max_unit_price_minor?: number;
  /** Per-line currency override. Note: when present alongside the
   *  parent profile's `currency`, profile-level currency wins on the
   *  wire today. */
  readonly currency?: string;
}

export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface SubscriptionProfile {
  readonly id: string;
  readonly site_id: string;
  readonly agent_aid: string;
  readonly cadence_iso8601: string;
  readonly line_items_jsonb: readonly SubscriptionLineItem[];
  readonly status: SubscriptionStatus;
  readonly paused_until: string | null;
  readonly next_run_at: string;
  readonly settlement_rail: string | null;
  readonly currency: string;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly cancelled_at: string | null;
}

/** Shared response shape for the lifecycle ops that mutate a profile and
 *  return the post-mutation row (pause / skip / cancel / modify_lines). */
export interface SubscriptionProfileResponse {
  readonly profile: SubscriptionProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/create_subscription
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSubscriptionRequest {
  readonly site_id: string;
  readonly cadence_iso8601: string;
  readonly line_items: readonly SubscriptionLineItem[];
  readonly settlement_rail?: string;
  readonly currency?: string;
  readonly notes?: string;
}

export type CreateSubscriptionResponse = SubscriptionProfileResponse;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/pause_subscription
// ─────────────────────────────────────────────────────────────────────────────

export interface PauseSubscriptionRequest {
  readonly profile_id: string;
  /** ISO 8601 timestamp. When present, the profile auto-resumes at
   *  this point. When absent, the profile is paused indefinitely. */
  readonly until?: string;
}

export type PauseSubscriptionResponse = SubscriptionProfileResponse;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/skip_next_run
// ─────────────────────────────────────────────────────────────────────────────

export interface SkipNextRunRequest {
  readonly profile_id: string;
}

export type SkipNextRunResponse = SubscriptionProfileResponse;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/cancel_subscription
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelSubscriptionRequest {
  readonly profile_id: string;
  readonly reason?: string;
}

export type CancelSubscriptionResponse = SubscriptionProfileResponse;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/modify_subscription_lines
// ─────────────────────────────────────────────────────────────────────────────

export interface ModifySubscriptionLinesRequest {
  readonly profile_id: string;
  readonly line_items: readonly SubscriptionLineItem[];
}

export type ModifySubscriptionLinesResponse = SubscriptionProfileResponse;

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/find_inventory (Date-Bound Inventory)
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryUnit {
  readonly id: string;
  readonly resource_id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly available_from: string | null;
  readonly available_until: string | null;
  readonly quantity: number;
  readonly unit_price_minor: number;
  readonly currency: string;
  readonly attributes_jsonb: Readonly<Record<string, unknown>>;
}

export interface FindInventoryRequest {
  readonly resource_id: string;
  readonly date_range: DateRange;
  readonly qty?: number;
  readonly criteria?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
}

export interface FindInventoryResponse {
  readonly units: readonly InventoryUnit[];
}
