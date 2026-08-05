// X402CoinbaseAdapter — FacetPaymentRailAdapter implementation for x402
// USDC settlement on Base via the Coinbase facilitator.
//
// Delegates verification and settlement to the official `x402` SDK
// (verify + settle from `x402/verify`) routed through `@coinbase/x402`'s
// preconfigured facilitator. We do NOT reimplement EIP-3009 verification,
// nonce dedup, or facilitator HTTP — the SDK handles all of that and
// will continue to handle protocol revisions without us tracking the
// wire format manually.
//
// This adapter handles ALL agents that settle over x402 — agents
// provisioned by AWS Bedrock AgentCore Payments AND agents provisioned
// by Coinbase AgentKit AND any other platform that produces a valid
// x402 PaymentPayload. The agent-side platform difference is at the
// attestation layer, handled by a separate FacetOriginationVerifier.

import type {
  CaptureInput,
  CaptureOk,
  FacetPaymentRailAdapter,
  RailAdapterMetadata,
  RailAdapterResult,
  RefundInput,
  RefundOk,
  ReserveAuthorityInput,
  ReserveAuthorityOk,
  VerifyAuthorityInput,
  VerifyAuthorityOk,
  WebhookOutcome,
  WebhookRequest,
} from "@facet-llc/adapter";
import { facilitator as defaultCoinbaseFacilitator } from "@coinbase/x402";
import type { FacilitatorConfig } from "x402/types";
import {
  ExactEvmPayloadSchema,
  PaymentPayloadSchema,
  type ExactEvmPayload,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
} from "x402/types";
import { useFacilitator } from "x402/verify";

import { decodePaymentHeader } from "./payment-header.ts";

const PACKAGE_VERSION = "0.1.0";

/** USDC contract addresses per x402 network. Sourced from
 *  https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
 *  and the USDC GitHub repo. Pinning here keeps the adapter
 *  network-bounded and auditable. */
const USDC_ADDRESSES: Readonly<Record<X402SupportedNetwork, `0x${string}`>> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

/** EIP-712 domain (name + version) of USDC per network. The x402 "exact" EVM
 *  scheme carries this in PaymentRequirements `extra` so the facilitator can
 *  reconstruct the domain and verify the EIP-3009 transferWithAuthorization
 *  signature; omitting it fails verify with
 *  `invalid_exact_evm_missing_eip712_domain`. base-sepolia verified on-chain
 *  (USDC.name()="USDC", version()="2"). base VERIFIED on-chain 2026-06-03
 *  against Base mainnet USDC 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:
 *  name()="USD Coin", version()="2" — matches the constant below. */
const USDC_EIP712_DOMAIN: Readonly<
  Record<X402SupportedNetwork, { readonly name: string; readonly version: string }>
> = {
  base: { name: "USD Coin", version: "2" },
  "base-sepolia": { name: "USDC", version: "2" },
};

/** EVM chain id per x402 network. This is the `chainId` the merchant-refund
 *  ERC-3009 signature is bound to (USDC.name()/version() alone do not pin the
 *  chain). Base mainnet = 8453, Base Sepolia = 84532. */
const CHAIN_ID_BY_NETWORK: Record<X402SupportedNetwork, number> = {
  base: 8453,
  "base-sepolia": 84532,
};

export type X402SupportedNetwork = Extract<Network, "base" | "base-sepolia">;

/** The EIP-712 typed-data shape the injected merchant refund signer consumes.
 *  Kept viem-free (this package never imports viem): the Terminal injects a KMS-
 *  or PK-backed signer whose `signTypedData` accepts exactly this object. */
interface RefundTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: `0x${string}`;
  };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/** A merchant-side signer for x402 refunds, injected through merchant_config by
 *  the Terminal (never held inline, per the adapter contract). Its `address`
 *  MUST equal the merchant payTo: a refund is an ERC-3009 transfer OUT of payTo,
 *  so only the payTo key can authorize it. */
interface RefundSigner {
  readonly address: string;
  readonly signTypedData: (args: RefundTypedData) => Promise<`0x${string}`>;
}

/** Independent on-chain settlement confirmation.
 *  The adapter delegates verify/settle to the facilitator; without this,
 *  `capture` trusts the facilitator's `settleResponse.success` with no
 *  on-chain proof a real, full-value Transfer landed. When a confirmer is
 *  injected, capture re-checks the settlement tx on a Facet-controlled RPC
 *  before returning ok — removing the facilitator from the settlement-
 *  integrity TCB. The Boson rail already does this (`confirmExchangeReleased`).
 *  Implemented by the Terminal (viem `getTransactionReceipt` + Transfer-log
 *  assertion) and injected here so this package stays free of an RPC dep. */
export type SettlementConfirmer = (params: {
  readonly txHash: string;
  readonly network: X402SupportedNetwork;
  /** USDC contract the Transfer must originate from. */
  readonly asset: `0x${string}`;
  /** Server-resolved merchant payout address the Transfer must credit. */
  readonly payTo: `0x${string}`;
  /** Server-derived amount (atomic) the on-chain Transfer value must be ≥. */
  readonly minValueAtomic: string;
}) => Promise<{ readonly ok: boolean; readonly reason?: string }>;

export interface X402CoinbaseAdapterConfig {
  /** The x402 network this adapter instance handles. One adapter per
   *  network — the Terminal dispatcher picks the right instance based
   *  on the inbound payload's `network` field. */
  readonly network: X402SupportedNetwork;
  /** Optional rail-id override. Defaults to the network-derived id
   *  (coin/usdc-base or coin/usdc-base-sepolia). The Stripe deposit venue
   *  registers a SECOND instance of this adapter under coin/usdc-stripe with the
   *  same network + facilitator, so a venue order (whose payTo is a per-order
   *  Stripe deposit address) settles through the identical on-chain facilitator +
   *  confirmer under a distinct dispatcher rail id. */
  readonly railId?: string;
  /** Optional facilitator override. Defaults to the Coinbase facilitator
   *  exported from `@coinbase/x402`. Pass `createFacilitatorConfig(id,
   *  secret)` from `@coinbase/x402` to use authenticated rate-limit
   *  tiers, or a custom URL for testnet / self-hosted facilitators. */
  readonly facilitator?: FacilitatorConfig;
  /** Default resource URL used in PaymentRequirements when the Terminal
   *  doesn't supply one. Should be the merchant's canonical origin. */
  readonly defaultResourceUrl?: string;
  /** Default merchant-readable description used in PaymentRequirements
   *  when the Terminal doesn't supply one. */
  readonly defaultDescription?: string;
  /** The base-mainnet USDC EIP-712 domain `name`
   *  ("USD Coin") is unverified-on-chain. A `base` adapter refuses to
   *  construct unless this is explicitly true, forcing the operator to
   *  confirm `USDC.name()`/`version()` on Base mainnet before the flip.
   *  Ignored for base-sepolia (verified). Default: false. */
  readonly baseEip712Verified?: boolean;
  /** Reject EIP-3009 authorizations whose
   *  `validBefore` is more than this many seconds in the future, bounding
   *  long-lived replay windows. Undefined = no bound (preserves current
   *  behavior; prod SHOULD set ~600). */
  readonly maxAuthWindowSeconds?: number;
  /** Independent on-chain settlement confirmation.
   *  Undefined = facilitator-trust only (current testnet behavior). MUST be
   *  set before `FACET_X402_NETWORK=base` (mainnet). */
  readonly confirmSettlement?: SettlementConfirmer;
  /** Clock injection for deterministic validity-window tests. */
  readonly now?: () => number;
}

export class X402CoinbaseAdapter implements FacetPaymentRailAdapter {
  public readonly metadata: RailAdapterMetadata;

  private readonly network: X402SupportedNetwork;
  private readonly facilitatorClient: ReturnType<typeof useFacilitator>;
  private readonly defaultResourceUrl: string;
  private readonly defaultDescription: string;
  private readonly maxAuthWindowSeconds: number | undefined;
  private readonly confirmSettlement: SettlementConfirmer | undefined;
  private readonly now: () => number;

  constructor(cfg: X402CoinbaseAdapterConfig) {
    this.network = cfg.network;
    // Refuse to construct a base-mainnet adapter until
    // the operator has confirmed the USDC EIP-712 domain on-chain. A wrong
    // domain fails closed (verify rejects), but constructing on an unverified
    // constant invites a silent mainnet-day-1 breakage; make it explicit.
    if (cfg.network === "base" && cfg.baseEip712Verified !== true) {
      throw new Error(
        "x402 base-mainnet adapter requires baseEip712Verified=true — confirm USDC.name()/version() " +
          'on Base mainnet (cast call 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 "name()(string)") ' +
          "and set the flag before enabling FACET_X402_NETWORK=base.",
      );
    }
    // @coinbase/x402 and x402 ship structurally-identical FacilitatorConfig
    // types from different package versions (@x402/core re-export vs x402's
    // own re-export). TypeScript sees them as distinct under strict mode;
    // the shapes are identical so a cast is safe and avoids forcing
    // consumers to know about the dependency split.
    const facilitatorConfig =
      cfg.facilitator ?? (defaultCoinbaseFacilitator as unknown as FacilitatorConfig);
    this.facilitatorClient = useFacilitator(facilitatorConfig);
    this.defaultResourceUrl = cfg.defaultResourceUrl ?? "https://facet.example/terminal";
    this.defaultDescription = cfg.defaultDescription ?? "Facet Terminal x402 payment";
    this.maxAuthWindowSeconds = cfg.maxAuthWindowSeconds;
    this.confirmSettlement = cfg.confirmSettlement;
    this.now = cfg.now ?? (() => Date.now());

    const facilitatorUrl: string = facilitatorConfig.url;
    this.metadata = {
      id: cfg.railId ?? (cfg.network === "base" ? "coin/usdc-base" : "coin/usdc-base-sepolia"),
      display_name:
        cfg.network === "base"
          ? "USDC on Base (x402, Coinbase facilitator)"
          : "USDC on Base Sepolia (x402, Coinbase facilitator)",
      version: PACKAGE_VERSION,
      supports_reserve_capture: false,
      supports_refund: true,
      supports_dispute: false,
      networks: [cfg.network],
      currencies: ["USDC"],
      egress_allowlist: [facilitatorUrl],
    };
  }

  async verifyAuthority(
    input: VerifyAuthorityInput,
  ): Promise<RailAdapterResult<VerifyAuthorityOk>> {
    const decoded = this.decodeHeader(input);
    if (decoded.kind === "error") return decoded.error;

    if (input.amount.currency !== "USDC") {
      return errResult(
        "INVALID_REQUEST",
        `Currency "${input.amount.currency}" not supported (USDC only)`,
      );
    }

    const evm = narrowEvmPayload(decoded.payload);
    if (evm === null) {
      return errResult(
        "INVALID_REQUEST",
        "Payload does not contain an EVM authorization (this adapter is EVM-only)",
      );
    }

    const authErr = this.checkAuthorization(evm, input.amount.amount);
    if (authErr !== null) return authErr;

    // SECURITY: payTo MUST come from per-site
    // merchant configuration, NEVER from the inbound payload. Without
    // this gate the adapter would accept attacker-self-paid x402
    // authorizations (attacker signs a transfer from 0xATTACK to
    // 0xATTACK, facilitator confirms the signature is valid, adapter
    // returns ok, merchant ships product against a net-zero payment).
    const expectedPayTo = readMerchantPayTo(input.merchant_config);
    if (expectedPayTo === null) {
      return errResult(
        "INVALID_REQUEST",
        "merchant_config.x402_pay_to_address is required — x402 rail not configured for this site",
      );
    }
    if (evm.authorization.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return makeError(
        "UNAUTHORIZED",
        `Payment authorization pays ${evm.authorization.to}; merchant payTo is ${expectedPayTo}`,
        false,
        "pay_to_mismatch",
      );
    }

    const requirements = this.buildRequirements({
      payTo: expectedPayTo as `0x${string}`,
      amountAtomic: String(input.amount.amount),
      resource: this.defaultResourceUrl,
      description: this.defaultDescription,
    });

    let verifyResponse;
    try {
      verifyResponse = await this.facilitatorClient.verify(decoded.payload, requirements);
    } catch (e) {
      return {
        kind: "error",
        code: "SETTLEMENT_FAILED",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }

    if (!verifyResponse.isValid) {
      return makeError(
        "UNAUTHORIZED",
        verifyResponse.invalidReason ?? "x402 verify rejected payload",
        false,
        verifyResponse.invalidReason,
      );
    }

    return {
      kind: "ok",
      value: {
        authority_handle: evm.authorization.nonce,
        expires_at: new Date(Number(evm.authorization.validBefore) * 1000).toISOString(),
      },
    };
  }

  async reserveAuthority(
    _input: ReserveAuthorityInput,
  ): Promise<RailAdapterResult<ReserveAuthorityOk>> {
    return {
      kind: "ok",
      value: { reservation_active: false, reserved_until: null },
    };
  }

  async capture(input: CaptureInput): Promise<RailAdapterResult<CaptureOk>> {
    const decoded = this.decodeHeader(input);
    if (decoded.kind === "error") return decoded.error;

    const evm = narrowEvmPayload(decoded.payload);
    if (evm === null) {
      return errResult("INVALID_REQUEST", "Payload does not contain an EVM authorization");
    }
    if (evm.authorization.nonce !== input.authority_handle) {
      return errResult(
        "INVALID_REQUEST",
        "authority_handle does not match X-PAYMENT nonce — replay or mismatch",
      );
    }

    const authErr = this.checkAuthorization(evm, input.amount.amount);
    if (authErr !== null) return authErr;

    // SECURITY: same payTo gate as verifyAuthority. Defense-in-
    // depth — if verifyAuthority somehow leaked, capture re-asserts.
    const expectedPayTo = readMerchantPayTo(input.merchant_config);
    if (expectedPayTo === null) {
      return errResult("INVALID_REQUEST", "merchant_config.x402_pay_to_address is required");
    }
    if (evm.authorization.to.toLowerCase() !== expectedPayTo.toLowerCase()) {
      return makeError(
        "UNAUTHORIZED",
        `Capture payTo mismatch: payload ${evm.authorization.to} vs config ${expectedPayTo}`,
        false,
        "pay_to_mismatch",
      );
    }

    const requirements = this.buildRequirements({
      payTo: expectedPayTo as `0x${string}`,
      amountAtomic: String(input.amount.amount),
      resource: this.defaultResourceUrl,
      description: this.defaultDescription,
    });

    let settleResponse;
    try {
      settleResponse = await this.facilitatorClient.settle(decoded.payload, requirements);
    } catch (e) {
      return {
        kind: "error",
        code: "SETTLEMENT_FAILED",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }

    if (!settleResponse.success) {
      return makeError(
        "SETTLEMENT_FAILED",
        settleResponse.errorReason ?? "Facilitator declined settlement",
        settleResponse.errorReason === "duplicate_settlement",
        settleResponse.errorReason,
      );
    }

    // Independently confirm the settlement landed
    // on-chain before reporting captured. Without a confirmer (testnet
    // default) we trust the facilitator's success flag; with one injected
    // (REQUIRED before the mainnet flip) we re-read the tx on a Facet-
    // controlled RPC and assert a full-value Transfer to the merchant payTo,
    // removing the facilitator from the settlement-integrity TCB.
    const txHash = settleResponse.transaction;
    if (this.confirmSettlement !== undefined) {
      if (typeof txHash !== "string" || txHash === "") {
        return makeError(
          "SETTLEMENT_FAILED",
          "Facilitator reported success without a settlement tx hash; cannot confirm on-chain",
          false,
          "settlement_unconfirmed",
        );
      }
      let confirmation: { readonly ok: boolean; readonly reason?: string };
      try {
        confirmation = await this.confirmSettlement({
          txHash,
          network: this.network,
          asset: USDC_ADDRESSES[this.network],
          payTo: expectedPayTo as `0x${string}`,
          minValueAtomic: String(input.amount.amount),
        });
      } catch (e) {
        return {
          kind: "error",
          code: "SETTLEMENT_FAILED",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        };
      }
      if (!confirmation.ok) {
        return makeError(
          "SETTLEMENT_FAILED",
          `On-chain settlement confirmation failed: ${confirmation.reason ?? "unconfirmed"}`,
          false,
          "settlement_unconfirmed",
        );
      }
    }

    return {
      kind: "ok",
      value: {
        settlement_id: txHash ?? input.authority_handle,
        settled_at: new Date(this.now()).toISOString(),
      },
    };
  }

  async refund(input: RefundInput): Promise<RailAdapterResult<RefundOk>> {
    // A refund is the symmetric inverse of capture: a fresh, merchant-signed
    // ERC-3009 transferWithAuthorization(from=payTo, to=refund_to, value=amount)
    // relayed by the SAME facilitator that settled the buyer->merchant capture
    // (gasless). The merchant payTo MUST be a signable EOA whose key the Terminal
    // wired in as x402_refund_signer; without it the rail cannot reverse funds.
    const payTo = readMerchantPayTo(input.merchant_config);
    if (payTo === null) {
      return errResult(
        "INVALID_REQUEST",
        "merchant_config.x402_pay_to_address is required (x402 rail not configured for this site)",
      );
    }
    const refundTo = input.refund_to;
    if (typeof refundTo !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(refundTo)) {
      return errResult(
        "INVALID_REQUEST",
        "x402 refund requires refund_to (a 0x address the refund pays back to)",
      );
    }
    // No self-refund: transferring payTo -> payTo is a net-zero on-chain move
    // that still burns the nonce and could mask a mis-set refund target.
    if (refundTo.toLowerCase() === payTo.toLowerCase()) {
      return errResult(
        "INVALID_REQUEST",
        "x402 refund_to must differ from the merchant payTo (no self-refund)",
      );
    }

    // Build the refund PaymentPayload. NON-CUSTODIAL FIRST: when the caller supplies
    // a MERCHANT-signed ERC-3009 send-back via authority.x_payment, RELAY it. Facet
    // holds no key. This is the mirror of capture: the buyer signs the capture, the
    // merchant signs the refund, and the SAME facilitator relays either gaslessly.
    // Because payTo is the merchant's OWN wallet, capture lands there and the refund
    // (and the net kept) stay in the merchant's wallet, fully non-custodial. Falls
    // back to a Facet-managed refund signer ONLY when no merchant signature is
    // supplied (the legacy managed-signer path, where payTo must equal that signer).
    let payload: PaymentPayload;
    const merchantSig = (input as { authority?: { x_payment?: unknown } }).authority?.x_payment;
    if (typeof merchantSig === "string" && merchantSig !== "") {
      const decoded = this.decodeHeader(input);
      if (decoded.kind === "error") return decoded.error;
      const evm = narrowEvmPayload(decoded.payload);
      if (evm === null) {
        return errResult(
          "INVALID_REQUEST",
          "x402 refund authority.x_payment must be an EVM ERC-3009 payload",
        );
      }
      // Bind the merchant-signed send-back to the Terminal's authorized refund: it
      // must move OUT of the merchant payTo, TO refund_to, for exactly the amount.
      // The facilitator re-verifies the signature itself; these checks stop a caller
      // from relaying a valid send-back to a different destination or value.
      const a = evm.authorization;
      if (a.from.toLowerCase() !== payTo.toLowerCase()) {
        return makeError(
          "UNAUTHORIZED",
          "x402 refund send-back must be signed FROM the merchant payTo",
          false,
          "refund_from_mismatch",
        );
      }
      if (a.to.toLowerCase() !== refundTo.toLowerCase()) {
        return errResult("INVALID_REQUEST", "x402 refund send-back `to` must equal refund_to");
      }
      if (String(a.value) !== String(input.amount.amount)) {
        return errResult(
          "INVALID_REQUEST",
          "x402 refund send-back `value` must equal the refund amount",
        );
      }
      payload = decoded.payload;
    } else {
      // Legacy CUSTODIAL fallback: a Facet-managed refund signer whose address MUST
      // equal payTo (else it could sign a transfer out of a wallet its key does not
      // control). Reached only when the merchant did not sign the send-back itself.
      const signer = readRefundSigner(input.merchant_config);
      if (signer === null) {
        return errResult(
          "INVALID_REQUEST",
          "x402 refund requires either a merchant-signed authority.x_payment (non-custodial) or a wired merchant refund signer",
        );
      }
      if (signer.address.toLowerCase() !== payTo.toLowerCase()) {
        return makeError(
          "UNAUTHORIZED",
          "refund signer is not the merchant payTo",
          false,
          "refund_signer_mismatch",
        );
      }
      // Build + sign the EIP-3009 authorization. validAfter=0 (valid immediately);
      // validBefore bounds the relay window (default 1h, or maxAuthWindowSeconds);
      // nonce is a single-use random 32-byte value.
      const nonce = randomNonce();
      const validBefore = String(
        Math.floor(this.now() / 1000) + (this.maxAuthWindowSeconds ?? 3600),
      );
      const authorization = {
        from: payTo,
        to: refundTo,
        value: String(input.amount.amount),
        validAfter: "0",
        validBefore,
        nonce,
      };
      let signature: `0x${string}`;
      try {
        signature = await signer.signTypedData({
          domain: {
            name: USDC_EIP712_DOMAIN[this.network].name,
            version: USDC_EIP712_DOMAIN[this.network].version,
            chainId: CHAIN_ID_BY_NETWORK[this.network],
            verifyingContract: USDC_ADDRESSES[this.network],
          },
          types: {
            TransferWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: {
            from: payTo,
            to: refundTo,
            value: BigInt(input.amount.amount),
            validAfter: 0n,
            validBefore: BigInt(validBefore),
            nonce,
          },
        });
      } catch (e) {
        return {
          kind: "error",
          code: "SETTLEMENT_FAILED",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        };
      }
      payload = {
        x402Version: 1,
        scheme: "exact",
        network: this.network as Network,
        payload: { signature, authorization },
      };
    }
    // requirements.payTo is the REFUND recipient. The facilitator settles the
    // signed transfer TO refund_to, and (when a confirmer is set) we re-check the
    // on-chain Transfer credited refund_to for >= amount.
    const requirements = this.buildRequirements({
      payTo: refundTo as `0x${string}`,
      amountAtomic: String(input.amount.amount),
      resource: this.defaultResourceUrl,
      description: "x402 refund",
    });

    let settleResponse;
    try {
      settleResponse = await this.facilitatorClient.settle(payload, requirements);
    } catch (e) {
      return {
        kind: "error",
        code: "SETTLEMENT_FAILED",
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      };
    }
    if (!settleResponse.success) {
      return makeError(
        "SETTLEMENT_FAILED",
        settleResponse.errorReason ?? "Facilitator declined refund settlement",
        false,
        settleResponse.errorReason,
      );
    }

    // Independently confirm the refund landed on-chain (same posture as capture):
    // re-read the tx on a Facet-controlled RPC and assert a full-value Transfer to
    // refund_to before reporting the refund ok. Testnet default trusts the
    // facilitator success flag; a confirmer is REQUIRED before the mainnet flip.
    const txHash = settleResponse.transaction;
    if (this.confirmSettlement !== undefined) {
      if (typeof txHash !== "string" || txHash === "") {
        return makeError(
          "SETTLEMENT_FAILED",
          "Facilitator reported refund success without a settlement tx hash; cannot confirm on-chain",
          false,
          "settlement_unconfirmed",
        );
      }
      let confirmation: { readonly ok: boolean; readonly reason?: string };
      try {
        confirmation = await this.confirmSettlement({
          txHash,
          network: this.network,
          asset: USDC_ADDRESSES[this.network],
          payTo: refundTo as `0x${string}`,
          minValueAtomic: String(input.amount.amount),
        });
      } catch (e) {
        return {
          kind: "error",
          code: "SETTLEMENT_FAILED",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        };
      }
      if (!confirmation.ok) {
        return makeError(
          "SETTLEMENT_FAILED",
          `On-chain refund confirmation failed: ${confirmation.reason ?? "unconfirmed"}`,
          false,
          "settlement_unconfirmed",
        );
      }
    }

    return {
      kind: "ok",
      value: {
        refund_id:
          settleResponse.transaction ?? narrowEvmPayload(payload)?.authorization.nonce ?? "",
        refunded_at: new Date(this.now()).toISOString(),
      } as RefundOk,
    };
  }

  async handleWebhook(_input: WebhookRequest): Promise<RailAdapterResult<WebhookOutcome>> {
    return {
      kind: "ok",
      value: { kind: "ignored", reason: "Coinbase x402 facilitator is synchronous" },
    };
  }

  /** Independently bind the
   *  signed EIP-3009 authorization to the server-derived amount and bound its
   *  validity window — WITHOUT delegating to the facilitator. Returns an
   *  error result to short-circuit, or null when the authorization passes. */
  private checkAuthorization(
    evm: ExactEvmPayload,
    requiredAmount: number,
  ): RailAdapterResult<never> | null {
    // The signed transfer value MUST equal the server-derived amount.
    // The facilitator also checks this against `requirements`, but Facet must
    // not delegate its own amount-provenance invariant.
    let signedValue: bigint;
    let requiredValue: bigint;
    try {
      signedValue = BigInt(evm.authorization.value);
      requiredValue = BigInt(String(requiredAmount));
    } catch {
      return errResult("INVALID_REQUEST", "authorization value / amount is not an integer");
    }
    if (signedValue !== requiredValue) {
      return makeError(
        "UNAUTHORIZED",
        `Authorized value ${signedValue} does not equal required amount ${requiredValue}`,
        false,
        "amount_mismatch",
      );
    }
    // Bound the validity window so a captured authorization is not
    // replay-eligible for an attacker-chosen (possibly multi-year) lifetime.
    const nowS = Math.floor(this.now() / 1000);
    const validAfter = Number(evm.authorization.validAfter);
    const validBefore = Number(evm.authorization.validBefore);
    if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
      return errResult("INVALID_REQUEST", "authorization validAfter/validBefore must be numeric");
    }
    if (validBefore <= nowS) {
      return makeError("UNAUTHORIZED", "authorization expired", false, "expired");
    }
    if (validAfter > nowS + 5) {
      return makeError("UNAUTHORIZED", "authorization not yet valid", false, "not_yet_valid");
    }
    if (this.maxAuthWindowSeconds !== undefined && validBefore - nowS > this.maxAuthWindowSeconds) {
      return makeError(
        "UNAUTHORIZED",
        `authorization window ${validBefore - nowS}s exceeds max ${this.maxAuthWindowSeconds}s`,
        false,
        "auth_window_too_long",
      );
    }
    return null;
  }

  private decodeHeader(
    input: VerifyAuthorityInput | CaptureInput | RefundInput,
  ):
    | { readonly kind: "ok"; readonly payload: PaymentPayload }
    | { readonly kind: "error"; readonly error: RailAdapterResult<never> } {
    const headerValue = (input as { authority?: { x_payment?: unknown } }).authority?.x_payment;
    if (typeof headerValue !== "string") {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          "authority.x_payment (base64-encoded X-PAYMENT header) is required",
        ),
      };
    }
    const decoded = decodePaymentHeader(headerValue);
    if (decoded.kind === "error") {
      return {
        kind: "error",
        error: errResult("INVALID_REQUEST", decoded.reason),
      };
    }
    if (decoded.payload.network !== this.network) {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          `Payment targets network "${decoded.payload.network}" but this adapter handles "${this.network}"`,
        ),
      };
    }
    const parsed = PaymentPayloadSchema.safeParse(decoded.payload);
    if (!parsed.success) {
      return {
        kind: "error",
        error: errResult(
          "INVALID_REQUEST",
          `Payload failed x402 schema validation: ${parsed.error.message}`,
        ),
      };
    }
    return { kind: "ok", payload: parsed.data };
  }

  private buildRequirements(opts: {
    payTo: `0x${string}`;
    amountAtomic: string;
    resource: string;
    description: string;
  }): PaymentRequirements {
    // PaymentRequirements.resource is `z.string().url()` per the canonical
    // x402 schema. Pass a plain string — the facilitator validates URL
    // shape server-side.
    return {
      scheme: "exact",
      network: this.network,
      maxAmountRequired: opts.amountAtomic,
      resource: opts.resource,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.payTo,
      maxTimeoutSeconds: 60,
      asset: USDC_ADDRESSES[this.network],
      // x402 "exact" EVM scheme: the facilitator needs the asset's EIP-712
      // domain to verify the EIP-3009 signature. Omitting it fails verify with
      // `invalid_exact_evm_missing_eip712_domain`.
      extra: USDC_EIP712_DOMAIN[this.network],
    };
  }
}

function errResult<T>(
  code: "UNAUTHORIZED" | "INVALID_REQUEST" | "SETTLEMENT_FAILED" | "METHOD_NOT_ALLOWED",
  message: string,
): RailAdapterResult<T> {
  return { kind: "error", code, message, retryable: false };
}

/** Build a typed-error result, only attaching native_code when present
 *  (exactOptionalPropertyTypes forbids passing undefined explicitly). */
function makeError<T>(
  code: "UNAUTHORIZED" | "INVALID_REQUEST" | "SETTLEMENT_FAILED" | "METHOD_NOT_ALLOWED",
  message: string,
  retryable: boolean,
  nativeCode: string | null | undefined,
): RailAdapterResult<T> {
  return nativeCode
    ? { kind: "error", code, message, retryable, native_code: nativeCode }
    : { kind: "error", code, message, retryable };
}

/** Narrow PaymentPayload.payload to the EVM variant. EVM payloads carry
 *  the EIP-3009 authorization fields we need; SVM payloads carry a raw
 *  Solana transaction blob this adapter doesn't handle. */
function narrowEvmPayload(payload: PaymentPayload): ExactEvmPayload | null {
  const inner = payload.payload as unknown;
  const parsed = ExactEvmPayloadSchema.safeParse(inner);
  return parsed.success ? parsed.data : null;
}

/** Read the server-side-resolved x402 pay-to address from merchant config.
 *  Returns null if missing or invalid; the caller rejects with the right
 *  error code. The Terminal resolves this from per-site merchant
 *  configuration. */
function readMerchantPayTo(cfg: Readonly<Record<string, unknown>>): string | null {
  const v = cfg["x402_pay_to_address"];
  if (typeof v !== "string") return null;
  return /^0x[a-fA-F0-9]{40}$/.test(v) ? v : null;
}

/** Read the merchant refund signer the Terminal wired into merchant_config
 *  (server-side, from a KMS key or hot PK whose address equals the site payTo).
 *  Returns null when absent or malformed, so the caller fails closed with
 *  METHOD/INVALID rather than throwing. Validates it is an object exposing a
 *  0x-hex `address` plus a `signTypedData` function; the payTo-equality gate is
 *  re-asserted in `refund` regardless. */
function readRefundSigner(cfg: Readonly<Record<string, unknown>>): RefundSigner | null {
  const v = cfg["x402_refund_signer"];
  if (v === null || typeof v !== "object") return null;
  const candidate = v as { address?: unknown; signTypedData?: unknown };
  if (typeof candidate.address !== "string") return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate.address)) return null;
  if (typeof candidate.signTypedData !== "function") return null;
  return candidate as RefundSigner;
}

/** 32-byte random nonce as a 0x-prefixed hex string, for the ERC-3009
 *  authorization. crypto.getRandomValues is available on all Terminal runtimes
 *  (Deno / Node 18+ / browsers); no dependency needed. */
function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}
