export { StripeAdapter } from "./adapter.ts";
export type {
  PaymentIntentRecord,
  PaymentIntentStore,
  StripeAdapterConfig,
  WebhookRejection,
  WebhookRejectionLogger,
} from "./adapter.ts";

// Deposit-mode (crypto / USDC) primitives for the venue that substitutes a
// Stripe-minted Base deposit address for the merchant's x402 payTo. See
// deposit-mode.ts. The Terminal calls these to provision the per-order address;
// on-chain settlement still runs through the x402 adapter plus confirmer.
export {
  buildDepositPaymentIntentParams,
  DEPOSIT_NETWORK,
  DEPOSIT_TOKEN,
  extractBaseDepositAddress,
  makeDepositStripeClient,
  PINNED_BASE_USDC,
  provisionDepositAddress,
  STRIPE_DEPOSIT_API_VERSION,
} from "./deposit-mode.ts";
export type {
  CryptoDepositAddressEntry,
  CryptoDepositPaymentMethodOptions,
  CryptoDisplayDetails,
  DepositPaymentIntentInput,
  ProvisionDepositResult,
  ProvisionedDeposit,
} from "./deposit-mode.ts";

// Re-export Stripe so consumers of the adapter package don't need to
// also depend directly on `stripe` to construct a client for injection
// or to consume webhook event types.
export { default as Stripe } from "stripe";
