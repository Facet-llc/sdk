// @facet-llc/payment-adapter-boson-escrow
//
// Facet payment-rail adapter for Boson Protocol x402B —
// escrow-backed "secure x402B" settlement on Base. RailId:
// coin/boson-escrow. Funds are held non-custodially in the Boson escrow
// Diamond; Facet never takes custody. Maps Boson's commit / redeem /
// release escrow lifecycle onto the Facet reserve / capture / finalize
// contract. See ./adapter.ts for the lifecycle mapping + invariants.

export {
  BosonEscrowAdapter,
  type BosonEscrowAdapterConfig,
  type BosonMerchantConfig,
  type BosonStores,
  type WebhookRejection,
  type WebhookRejectionLogger,
} from "./adapter.ts";

// BPIP-1 offer-metadata builder + the serve-route codec. The host server mounts
// `GET /v1/boson/offer-metadata` over `decodeMetadataPath` so the on-chain
// `metadataUri` resolves to the exact bytes `metadataHash` commits to.
export {
  buildOfferMetadata,
  decodeMetadataPath,
  encodeMetadataPath,
  metadataParamFromUrl,
  canonicalStringify,
  OFFER_METADATA_PATH,
  BOSON_METADATA_TYPE_BASE,
  BOSON_BASE_SCHEMA_URL,
  type BosonBaseMetadata,
  type BosonMetadataAttribute,
  type BuildOfferMetadataInput,
  type BuiltOfferMetadata,
  type OfferProductInfo,
} from "./metadata.ts";

// Re-export the Boson SDK store + reader contracts so a host can implement
// the injected persistence + on-chain reader against this single package
// surface, without reaching into the Boson SDK directly.
export type {
  ExchangeReader,
  ExchangeSnapshot,
  FulfillmentRecoveryEntry,
  SellerSigner,
  Store,
} from "@bosonprotocol/x402-server";
