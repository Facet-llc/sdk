# @facet-llc/protocol — changelog

All notable changes to this package are documented here. The protocol
version itself is tracked via the `FACET_PROTOCOL_VERSION` constant in
`src/terminal-types.ts` and bumps independently from the npm package
version (which can patch-version on docs / build-system changes alone).

## Unreleased

### feat: agents.txt v1.2 — `OpenAPI:` field

- New optional top-level field on the `agents.txt` reference parser:
  `OpenAPI` (URL). Points at the Terminal's canonical OpenAPI 3.1
  spec served at `GET /v1/openapi.json`. SDK generators read this URL
  to materialize a typed client against the per-merchant
  overlay-resolved contract (Phase 7 of openapi-as-contract).
- New `AgentsTxt.openApiUrl?: string` field on the typed result.
- `KNOWN_TOP_LEVEL` extended so the field doesn't leak into
  `unknownFields`.
- v0.2 / v1.0 / v1.1 documents continue to parse unchanged — the field
  is purely additive.
- Spec: `specs/agents.txt-v1.1.md` §5 + §10.1 (v1.2 delta block).
- Phase 5 of openapi-as-contract.

### note: version-constant unification (Phase 2 deferred work)

- `FACET_VERSION` (previously hardcoded `"0.1.0"` in
  `@facet-llc/schema-generator-core/src/emit.ts`) is now a re-export of
  `FACET_PROTOCOL_VERSION` from this package. The two constants now
  share a single source of truth; the schema-generator emits the same
  version string that the Terminal reports on `/v1/version`. No
  protocol shape change — `FACET_PROTOCOL_VERSION` stays at `0.2.0`.

## 0.2.0 — Phase 2 of openapi-as-contract (2026-05-26)

Additive expansion of the wire-contract surface. Brings typed-route
coverage from 26 of 67 (39%) to 67 of 67 (100%) per the Phase 1 audit. No existing
exports changed — every entry below is a new export.

- `FACET_PROTOCOL_VERSION`: `0.1.0` → `0.2.0`

### New per-primitive type modules

- `src/booking-types.ts` — `FindSlots*`, `HoldSlot*`, `ConfirmBooking*`,
  `ModifyBooking*`, `CancelBooking*` request/response types, plus
  re-located adapter-result types (`AdapterSlot`, `HoldSlotResult`,
  `ConfirmBookingResult`, `ModifyBookingResult`,
  `CancelBookingResult`), the shared `DateRange`, and `BookingAttendee`.
- `src/subscription-types.ts` — `CreateSubscription*`,
  `PauseSubscription*`, `SkipNextRun*`, `CancelSubscription*`,
  `ModifySubscriptionLines*`, `FindInventory*` request/response types,
  plus re-located `SubscriptionProfile`, `SubscriptionLineItem`,
  `SubscriptionStatus`, `SubscriptionProfileResponse`, and
  `InventoryUnit`.
- `src/rfq-types.ts` — `SubmitRfq*`, `GetRfqStatus*`, `AcceptQuote*`,
  `CounterQuote*`, `CancelRfq*` request/response types, plus
  re-located `RfqRequest`, `RfqQuote`, `RfqAttachment`,
  `RfqRequestStatus`, `RfqQuoteStatus`.
- `src/auction-types.ts` — `ListAuctions*`, `GetAuction*`, `PlaceBid*`,
  `GetBidStatus*` request/response types, plus re-located `AuctionRow`,
  `AuctionStatus`, `PublicAuction`, `BidSummary`.
- `src/graph-types.ts` — `GraphMatch*`, `GraphRelated*`, `GraphPath*`
  request/response types, plus re-located `MatchHit`, `RelatedNode`,
  `RelatedEdge`, and the new closed literal unions `KgNodeType` +
  `KgRelation`.
- `src/payment-dispatch-types.ts` — `PaymentsDispatchRequest`
  (discriminated union on `op` covering all 6 variants),
  `PaymentsDispatchResponse`, `DispatchAgentSummary`,
  `PaymentsCapabilitiesResponse`, `PaymentsRouteRequest`,
  `PaymentsRouteResponse`. **SECURITY:** the new
  `PaymentsDispatchRequest` deliberately does NOT carry a
  `merchant_config` field — the Terminal discards any caller-supplied
  merchant_config and rebuilds it server-side from the authenticated
  site row. The pre-Phase-2 local `DispatchRequestBody` in handler.ts
  advertised a field that the handler silently ignored; this type is
  the correct shape.
- `src/stripe-types.ts` — `StripeOnboardingLink*`, `StripeBalance*`
  (with `StripeBalanceAmount`), `StripeCheckoutSession*` request /
  response types, plus the `StripeWebhookAck` discriminated union
  covering all 6 ack variants the Stripe webhook handler returns.
- `src/verify-domain-types.ts` — `VerifyDomainRequest`,
  `VerifyDomainResponse` (flattened wire shape), `VerificationMethod`,
  `VerifyDomainOutcome` (re-located handler-side internal union).

### New supplementary types in `src/terminal-types.ts`

- `SessionExtendResponse` — alias of `IdentifyResponse` for spec
  clarity on `POST /v1/session_extend`.
- `HelloResponse` — `POST /v1/hello`.
- `MsIdentityAssociationResponse` + `MsIdentityAssociatedApplication`
  — vendor-frozen Entra publisher-domain verification shape.
- `OmsPushOrderRequest` + `OmsPushOrderResponse` —
  `POST /v1/oms/push_order`.
- `QuoteLicenseRequest`, `QuoteLicenseResponse`, `LicenseOffer` —
  `POST /v1/quote_license`. The `LicenseOffer` interface carries an
  `[key: string]: unknown` index signature because the underlying
  backing RPC may add fields ahead of the protocol catching up.
- `SubmitProofAttestationRequest`, `SubmitProofAttestationResponse`,
  `ProofKind` literal union, `PROOF_KINDS` constant array.
- `CalendlyWebhookResponse` (discriminated union),
  `CalendlyWebhookAckIgnored`, `CalendlyWebhookAckNoMatch`,
  `CalendlyWebhookAckConfirmed`, `CalendlyWebhookRateLimited`.

## 0.1.0 — initial release

- `FACET_PROTOCOL_VERSION` constant.
- `FacetErrorCode` closed union + `FacetErrorEnvelope`.
- 26 fully-typed routes (commerce primitives, content licensing,
  webhooks, identity, reputation, key bundle, capabilities, terms,
  version, health).
- Rail-adapter interface (`FacetPaymentRailAdapter`,
  `RailAdapterResult`, `MoneyAmount`, `RailId`, etc.).
- Origination-verifier interface
  (`FacetOriginationVerifier`, `AgentPrincipal`, etc.).
- Subscription tier catalog (`SUBSCRIPTION_TIERS`,
  `STRIPE_PRICE_TO_TIER`).
- Webhook event catalog (`WEBHOOK_EVENTS`,
  `WebhookDeliveryEnvelope<T>`).
- agents.txt v0.2 parser + types.
