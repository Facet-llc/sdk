export { StripeAdapter } from "./adapter.ts";
export type {
  PaymentIntentRecord,
  PaymentIntentStore,
  StripeAdapterConfig,
  WebhookRejection,
  WebhookRejectionLogger,
} from "./adapter.ts";

// Re-export Stripe so consumers of the adapter package don't need to
// also depend directly on `stripe` to construct a client for injection
// or to consume webhook event types.
export { default as Stripe } from "stripe";
