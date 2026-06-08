# @facet-llc/payment-adapter-stripe

Facet Terminal payment-rail adapter for the Stripe rail (cards, ACH, wallets). Implements `FacetPaymentRailAdapter` from [`@facet-llc/protocol`](https://www.npmjs.com/package/@facet-llc/protocol) on top of the official [`stripe`](https://www.npmjs.com/package/stripe) npm package.

## What this is

The card and ACH half of Facet's multi-rail payment-acceptance layer. Delegates the full PaymentIntent lifecycle to Stripe's SDK. We do not reimplement the form-encoded API client, the PI state machine, or the HMAC-SHA256 webhook signature dance.

| Rail call          | Stripe SDK call                                                                    |
| ------------------ | ---------------------------------------------------------------------------------- |
| `verifyAuthority`  | `paymentIntents.create(... capture_method: "manual")` or `paymentIntents.retrieve` |
| `reserveAuthority` | `paymentIntents.retrieve` (status check only)                                      |
| `capture`          | `paymentIntents.capture(id, { amount_to_capture })`                                |
| `refund`           | `refunds.create({ payment_intent \| charge, amount, reason })`                     |
| `dispute`          | `disputes.update(... submit: true)` or `disputes.close`                            |
| `handleWebhook`    | `webhooks.constructEventAsync(rawBody, sigHeader, secret)`                         |

The adapter returns `CaptureOk { settlement_id: "pi_...", settled_at }` so SDK consumers can treat Stripe and on-chain rails uniformly.

## Install

```bash
npm install @facet-llc/payment-adapter-stripe
# or
pnpm add @facet-llc/payment-adapter-stripe
```

## `merchant_config` shape

```ts
{
  api_key: "sk_live_…",            // required
  webhook_secret: "whsec_…",       // required for handleWebhook
  connect_account_id: "acct_…",    // optional; Stripe Connect destination
  application_fee_minor: 100,      // optional; platform fee in cents
  webhook_tolerance_seconds: 300,  // optional; default 300
}
```

When `connect_account_id` is set, the adapter routes all calls through the `Stripe-Account` header so the PaymentIntent lives on the connected account. If `application_fee_minor` is also set, the adapter collects a platform fee via `transfer_data` and `application_fee_amount` on PI creation.

## Authority artifact shape

The Terminal passes `authority` to `verifyAuthority` in one of two forms:

```ts
// Path A: caller supplies a PaymentMethod; adapter creates a fresh PI
{
  payment_method: "pm_…";
}

// Path B: caller already has an existing PI; adapter just validates
{
  payment_intent: "pi_…";
}
```

## Error mapping

Stripe SDK errors map onto Facet's `FacetErrorCode` taxonomy:

| Stripe error class                 | Facet code          | Retryable |
| ---------------------------------- | ------------------- | --------- |
| `StripeRateLimitError`             | `rate_limited`      | n/a       |
| `StripeAuthenticationError`        | `UNAUTHORIZED`      | false     |
| `StripeCardError`                  | `SETTLEMENT_FAILED` | false     |
| `StripeInvalidRequestError`        | `INVALID_REQUEST`   | false     |
| `StripeIdempotencyError`           | `INVALID_REQUEST`   | false     |
| `StripeAPIError` (transient 5xx)   | `SETTLEMENT_FAILED` | true      |
| `StripeConnectionError`            | `SETTLEMENT_FAILED` | true      |
| `StripeSignatureVerificationError` | `UNAUTHORIZED`      | false     |

The rail-native code lands in `RailAdapterResult.error.native_code` for forensics.

## Notes

- The adapter passes the Facet trace id, idempotency key, merchant id, and site id into Stripe metadata on every PI and refund. A charge in the Stripe dashboard traces back to the originating Facet request without correlating across systems.
- The Stripe SDK's built-in idempotency-key handling is wired to `ctx.idempotency_key` for every call so retries do not produce duplicate PIs or refunds.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
