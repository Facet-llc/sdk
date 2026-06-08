export { X402CoinbaseAdapter } from "./adapter.ts";
export type {
  SettlementConfirmer,
  X402CoinbaseAdapterConfig,
  X402SupportedNetwork,
} from "./adapter.ts";

export { decodePaymentHeader, encodePaymentHeader } from "./payment-header.ts";
export type { DecodeResult } from "./payment-header.ts";

// Convenience re-exports so adapter consumers don't have to also import
// from `x402/types` and `@coinbase/x402` to wire things up.
export { facilitator, createFacilitatorConfig } from "@coinbase/x402";
export type {
  FacilitatorConfig,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "x402/types";
