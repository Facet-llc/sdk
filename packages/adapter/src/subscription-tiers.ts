// Facet subscription tier catalog.
//
// Tier → monthly price + Stripe price id + rate-limit multiplier.
// Consumed by both the Terminal (tier ↔ price lookup in the Stripe
// webhook + Checkout session route) and the billing UI (plan cards).
//
// Dual-mode Stripe ids: `stripePriceId` and `stripePriceIdLive` hold the
// test-mode and live-mode price ids respectively. `STRIPE_PRICE_TO_TIER`
// maps inbound webhook events from either mode back to a tier.

export type SubscriptionTier = "free" | "pro" | "enterprise";

export interface SubscriptionTierDefinition {
  readonly tier: SubscriptionTier;
  readonly name: string;
  readonly monthlyPriceMinor: number;
  readonly currency: "USD";
  // Terminal multiplies the default rate-limit ceiling by this.
  // Mirrors the per-tier rate-limit multiplier default.
  readonly rateLimitMultiplier: number;
  // Stripe price id (test-mode). Absent for free tier — no Stripe.
  readonly stripePriceId: string | null;
  // Stripe price id (live-mode). Absent for free tier. Used by the
  // webhook handler's reverse map so live-mode subscription events
  // route to the correct tier.
  readonly stripePriceIdLive: string | null;
  // Monthly bot-request cap — enforced independently of the hourly
  // rate-limit. Null = no cap (count of requests doesn't carry a
  // monthly ceiling; the only gate is rate-limit-per-hour). Free
  // tier is the only capped tier; pro/enterprise are gated by
  // hourly multiplier and usage-based pricing.
  readonly monthlyBotCap: number | null;
  readonly features: readonly string[];
}

export const SUBSCRIPTION_TIERS: Readonly<Record<SubscriptionTier, SubscriptionTierDefinition>> = {
  free: {
    tier: "free",
    name: "Free",
    monthlyPriceMinor: 0,
    currency: "USD",
    rateLimitMultiplier: 1.0,
    stripePriceId: null,
    stripePriceIdLive: null,
    monthlyBotCap: 10_000,
    features: [
      "10,000 bot requests / month",
      "1,000 requests/hour burst limit",
      "Core Facet protocol endpoints",
      "Public agent reputation API",
      "Catalog changes feed",
    ],
  },
  pro: {
    tier: "pro",
    name: "Pro",
    monthlyPriceMinor: 29_900,
    currency: "USD",
    rateLimitMultiplier: 2.0,
    stripePriceId: "price_1TP8IOJtlJVSwXRah2y5ewu6",
    stripePriceIdLive: "price_1TPA7EFAt6IkK9T129K2SLUY",
    monthlyBotCap: null,
    features: [
      "Unmetered bot requests",
      "2,000 requests/hour burst limit (2× base)",
      "Everything in Free",
      "Webhook event delivery",
      "Priority email support",
      "Custom agents.txt fields",
    ],
  },
  enterprise: {
    tier: "enterprise",
    name: "Enterprise",
    monthlyPriceMinor: 99_900,
    currency: "USD",
    rateLimitMultiplier: 5.0,
    stripePriceId: "price_1TP8IPJtlJVSwXRaZWJLvf9n",
    stripePriceIdLive: "price_1TPA7FFAt6IkK9T1z5p0oJX2",
    monthlyBotCap: null,
    features: [
      "Unmetered bot requests",
      "5,000 requests/hour burst limit (5× base)",
      "Everything in Pro",
      "SLA-backed uptime commitments",
      "Dedicated onboarding + account manager",
      "Custom rate-limit tuning",
    ],
  },
};

// Reverse lookup: Stripe price id → tier. The Stripe webhook handler
// consults this map to decide which tier to upgrade a site to on
// `checkout.session.completed`. Both test + live price ids are
// registered so subscriptions from either Stripe mode resolve
// correctly. An unknown price id signals drift between the codebase
// and Stripe — the handler logs + ignores.
export const STRIPE_PRICE_TO_TIER: Readonly<Record<string, SubscriptionTier>> = {
  [SUBSCRIPTION_TIERS.pro.stripePriceId!]: "pro",
  [SUBSCRIPTION_TIERS.pro.stripePriceIdLive!]: "pro",
  [SUBSCRIPTION_TIERS.enterprise.stripePriceId!]: "enterprise",
  [SUBSCRIPTION_TIERS.enterprise.stripePriceIdLive!]: "enterprise",
};
