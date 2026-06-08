# Changelog

All notable changes to this repository are documented here. Each package additionally maintains its own version in its `package.json`; the cross-package release moments are summarized below.

## [Initial open-source release] — 2026-05-26

First public mirror of the Facet SDK monorepo. Seven packages, six newly on npm.

### Published to npm

- `@facet-llc/protocol@0.3.0` — closes the npm gap from 0.2.1; adds payment-dispatch types, RFQ/booking/subscription contracts, and the `FacetPaymentRailAdapter` interface used by both Stripe and x402 adapters.
- `@facet-llc/sdk-node@0.1.0` — first publish. One-call agent entry point.
- `@facet-llc/payment-adapter-x402-coinbase@0.1.0` — first publish. x402 USDC settlement on Base via the Coinbase facilitator.
- `@facet-llc/payment-adapter-stripe@0.2.0` — first publish. Stripe PaymentIntents with reserve-capture.
- `@facet-llc/origination-aws-agentcore@0.2.0` — first publish. AWS Bedrock AgentCore Payments helpers.
- `@facet-llc/origination-coinbase-cdp@0.2.0` — first publish. Coinbase Developer Platform AgentKit credential verifier.

### Already on npm (mirrored here for source access)

- `@facet-llc/client@0.2.1` — agent-side Terminal client.
