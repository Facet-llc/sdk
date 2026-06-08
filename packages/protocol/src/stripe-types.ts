// @facet-llc/protocol — Stripe Connect onboarding + billing types.
//
// Wire types for the four Stripe-facing Terminal routes:
//   POST /v1/stripe/onboarding_link
//   POST /v1/stripe/balance
//   POST /v1/stripe/checkout_session
//   POST /v1/stripe/webhook
//
// Two of these are vendor-relay endpoints:
//   - /v1/stripe/webhook receives Stripe's `Event` envelope (vendor-
//     frozen shape we do not own). The response (`StripeWebhookAck`)
//     IS Facet-owned — Stripe ignores the body, so the variants are
//     primarily for downstream log inspection.
//   - The balance endpoint wraps Stripe's `Balance` SDK shape via
//     `StripeBalanceAmount`.

import type { SubscriptionTier } from "./subscription-tiers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/stripe/onboarding_link
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeOnboardingLinkRequest {
  readonly site_id: string;
  readonly email?: string;
}

export interface StripeOnboardingLinkResponse {
  readonly account_id: string;
  readonly onboarding_url: string;
  /** Unix epoch seconds — Stripe-issued expiry on the onboarding link. */
  readonly expires_at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/stripe/balance
// ─────────────────────────────────────────────────────────────────────────────

/** Per-currency balance bucket. Mirrors Stripe's `Balance.available[]`
 *  / `Balance.pending[]` SDK shape. The optional `source_types`
 *  breakdown is included when Stripe surfaces it (card / bank /
 *  fpx / etc.). */
export interface StripeBalanceAmount {
  readonly amount: number;
  readonly currency: string;
  readonly source_types?: Readonly<Record<string, number>>;
}

export interface StripeBalanceRequest {
  readonly site_id: string;
}

export interface StripeBalanceResponse {
  readonly connected: boolean;
  readonly account_id: string | null;
  readonly charges_enabled: boolean;
  readonly payouts_enabled: boolean;
  readonly details_submitted: boolean;
  readonly available: readonly StripeBalanceAmount[];
  readonly pending: readonly StripeBalanceAmount[];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/stripe/checkout_session
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeCheckoutSessionRequest {
  readonly site_id: string;
  /** Constrained to paid tiers — "pro" or "enterprise". Use the
   *  Stripe Customer Portal to downgrade to "free". */
  readonly tier: SubscriptionTier;
  readonly email?: string;
}

export interface StripeCheckoutSessionResponse {
  readonly session_id: string;
  readonly url: string;
  readonly tier: SubscriptionTier;
  readonly site_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/stripe/webhook
//
// The request body is vendor-frozen (Stripe's `Event` envelope). The
// response shape varies by what the handler did with the event:
// ─────────────────────────────────────────────────────────────────────────────

/** Mode-mismatch ack: Terminal is in live mode but received a sandbox
 *  event (or vice versa). Returns 200 so Stripe stops retrying. */
export interface StripeWebhookAckModeMismatch {
  readonly received: true;
  readonly ignored: "mode_mismatch";
  readonly event_livemode: boolean;
  readonly terminal_livemode: boolean;
}

/** Generic ignored ack — Stripe sent an event type the handler
 *  doesn't act on. `ignored` carries a short reason string. */
export interface StripeWebhookAckIgnored {
  readonly received: true;
  readonly ignored: string;
}

/** payment_intent.{succeeded,payment_failed,canceled} +
 *  charge.refunded ack — references the resolved content license
 *  the Terminal flipped (or null when no payment intent matched). */
export interface StripeWebhookAckLicense {
  readonly received: true;
  readonly license_id: string | null;
  readonly status: "succeeded" | "failed" | "refunded";
}

/** checkout.session.completed (subscription mode) ack — confirms the
 *  Terminal upserted a tier change. */
export interface StripeWebhookAckCheckoutCompleted {
  readonly received: true;
  readonly tier: SubscriptionTier;
  readonly site_id: string;
  readonly subscription_id: string;
}

/** customer.subscription.updated ack — confirms the Terminal
 *  finalized the subscription row. `site_id` is null if no matching
 *  row was found. */
export interface StripeWebhookAckSubscriptionUpdated {
  readonly received: true;
  readonly subscription_id: string;
  readonly site_id: string | null;
  readonly status: "active" | "past_due" | "canceled" | "incomplete";
}

/** customer.subscription.deleted ack — confirms the Terminal
 *  flipped the site to the free tier. */
export interface StripeWebhookAckSubscriptionDeleted {
  readonly received: true;
  readonly subscription_id: string;
  readonly site_id: string | null;
  readonly tier: SubscriptionTier;
}

export type StripeWebhookAck =
  | StripeWebhookAckModeMismatch
  | StripeWebhookAckIgnored
  | StripeWebhookAckLicense
  | StripeWebhookAckCheckoutCompleted
  | StripeWebhookAckSubscriptionUpdated
  | StripeWebhookAckSubscriptionDeleted;
