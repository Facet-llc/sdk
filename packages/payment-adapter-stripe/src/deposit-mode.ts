// Stripe deposit-mode (crypto / USDC) primitives.
//
// Deposit mode is a DIFFERENT Stripe lifecycle from the card/ACH PaymentIntent
// flow in adapter.ts. There is no manual capture: Stripe mints a per-PaymentIntent
// on-chain deposit address, the payer sends USDC to it, and Stripe DETECTS the
// transfer and AUTO-CAPTURES (requires_action -> processing -> succeeded). So
// settlement is webhook-driven, never a synchronous capture() call. The adapter
// that maps this onto FacetPaymentRailAdapter lives in a sibling file; this module
// holds only the mechanical Stripe primitives, which are unambiguous.
//
// It isolates TWO things that must not leak into the stable card adapter:
//
//   1. THE VERSION. Deposit mode requires a preview wire API version, distinct
//      from the one adapter.ts pins for the card rail. Repointing the stable
//      client at a preview version is not safe, so the deposit client is built
//      separately here.
//   2. THE TYPED CAST SEAM. The crypto deposit-mode request params and the
//      crypto_display_details response are absent from the stripe@22 TypeScript
//      defs (Stripe's own sample casts them). Every cast is contained in this one
//      module rather than sprayed through the adapter.
//
// SCOPE: Base USDC only. The venue exists so a Base-native paying agent funds a
// Stripe deposit address with the exact asset (USDC) on the exact chain (Base) it
// already uses for x402-direct: the Base USDC contract Stripe lists
// (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) is byte-for-byte the one the
// x402-settlement-confirmer already pins. Tempo and Solana are supported by Stripe
// but out of scope: enabling them would require the paying agent to hold those
// chains.

import Stripe from "stripe";

/** The wire API version Stripe requires for crypto deposit mode. ISOLATED from
 *  adapter.ts's STRIPE_API_VERSION on purpose: this is a PREVIEW version, and
 *  repointing the stable card client at it is not safe. Bump only in lockstep
 *  with Stripe's deposit-mode GA. */
export const STRIPE_DEPOSIT_API_VERSION = "2026-03-25.preview";

/** The single network this venue accepts, used verbatim as the
 *  deposit_options.networks[] entry AND the deposit_addresses response key. */
export const DEPOSIT_NETWORK = "base" as const;

/** USDC token identifier Stripe returns under supported_tokens[].token_currency. */
export const DEPOSIT_TOKEN = "usdc" as const;

/** Base USDC contract. This is the SAME contract the x402-settlement-confirmer
 *  pins, and the paying agent will sign an ERC-3009 transfer of THIS token to the
 *  deposit address. A deposit address minted for any other token would leave the
 *  agent's payment unmatched at Stripe and the funds stranded (Stripe cannot
 *  auto-return an unmatched deposit), so extractBaseDepositAddress refuses any
 *  Base entry whose supported USDC token is not this contract. Compared
 *  case-insensitively. */
export const PINNED_BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Build a Stripe client pinned to the deposit-mode preview API version. Kept
 *  separate from adapter.ts's stable card client so the two versions never cross.
 *  The version is a preview string the SDK's LatestApiVersion literal does not
 *  include, so the pin is cast at this single seam. */
export function makeDepositStripeClient(apiKey: string, injected?: Stripe): Stripe {
  if (injected !== undefined) return injected;
  // The preview version is not in the SDK's pinned apiVersion literal. Reference
  // the constructor's config type structurally (the SDK does not export it by a
  // stable name across majors) and cast the pin at this one seam.
  type StripeCtorConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>;
  return new Stripe(apiKey, {
    apiVersion: STRIPE_DEPOSIT_API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
  } as unknown as StripeCtorConfig);
}

// ─────────────────────────────────────────────────────────────────────────────
// The typed cast seam. stripe@22 has no types for crypto deposit mode, so these
// interfaces describe exactly the request slice and response slice this venue
// touches, and the two casts below are the ONLY place the adapter steps outside
// the SDK's types.
// ─────────────────────────────────────────────────────────────────────────────

/** The crypto deposit-mode slice of payment_method_options, absent from the
 *  stripe@22 PaymentIntentCreateParams type. */
export interface CryptoDepositPaymentMethodOptions {
  readonly crypto: {
    readonly mode: "deposit";
    readonly deposit_options: {
      /** Networks to mint a deposit address on. This venue passes exactly
       *  [DEPOSIT_NETWORK]. */
      readonly networks: readonly string[];
    };
  };
}

/** One network's entry inside next_action.crypto_display_details.deposit_addresses. */
export interface CryptoDepositAddressEntry {
  readonly address: string;
  readonly supported_tokens?: ReadonlyArray<{
    readonly token_currency: string;
    readonly token_contract_address: string;
  }>;
}

/** The next_action.crypto_display_details response slice, absent from the
 *  stripe@22 PaymentIntent.NextAction type. */
export interface CryptoDisplayDetails {
  readonly deposit_addresses: Readonly<Record<string, CryptoDepositAddressEntry>>;
}

/** Inputs the deposit-mode PI-create params are built from. Plain primitives, so
 *  this module stays decoupled from the FacetPaymentRailAdapter input types (the
 *  adapter adapts the interface inputs to these). */
export interface DepositPaymentIntentInput {
  /** Amount in USD minor units (cents). Deposit mode fixes currency to USD;
   *  Stripe matches the exact 6-decimal USDC value on-chain. */
  readonly amountMinor: number;
  /** Facet-side identity metadata written onto the PI and read back on the
   *  settlement webhook. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Platform application fee in cents, routed to Facet's account atomically.
   *  Only emitted when a connected account is present (direct-charge posture). */
  readonly applicationFeeMinor?: number;
  /** Whether a connected account is in play. When true the fee is attached;
   *  the Stripe-Account request option is applied by the caller, mirroring
   *  adapter.ts's requestOptionsFor. */
  readonly onConnectedAccount: boolean;
}

/** Build the create params for a deposit-mode PaymentIntent. The crypto
 *  payment_method_options are cast at this one seam (stripe@22 lacks the type).
 *
 *  NON-CUSTODIAL POSTURE, unchanged from the card rail: no transfer_data.destination.
 *  The PI is created ON the connected account (the caller applies
 *  { stripeAccount } in request options), so funds settle to the merchant's
 *  Stripe balance directly; application_fee_amount routes only Facet's fee to the
 *  platform account. Adding transfer_data.destination would switch to destination
 *  charges and break the invariant. */
export function buildDepositPaymentIntentParams(
  input: DepositPaymentIntentInput,
): Stripe.PaymentIntentCreateParams {
  const cryptoOptions: CryptoDepositPaymentMethodOptions = {
    crypto: {
      mode: "deposit",
      deposit_options: { networks: [DEPOSIT_NETWORK] },
    },
  };
  return {
    amount: input.amountMinor,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_data: { type: "crypto" },
    // Cast seam #1: the crypto deposit-mode options are not in the stripe@22 type.
    // NonNullable because exactOptionalPropertyTypes rejects a `| undefined` here.
    payment_method_options: cryptoOptions as unknown as NonNullable<
      Stripe.PaymentIntentCreateParams["payment_method_options"]
    >,
    confirm: true,
    metadata: { ...input.metadata },
    // Direct charges only. Attach the platform fee when a connected account is in
    // play AND the fee is positive; a 0 fee omits the field, matching the card
    // rail's `feeRate > 0` gate. Never transfer_data.destination (see the note above).
    ...(input.onConnectedAccount &&
    typeof input.applicationFeeMinor === "number" &&
    input.applicationFeeMinor > 0
      ? { application_fee_amount: input.applicationFeeMinor }
      : {}),
  };
}

/** Read the Base USDC deposit address out of a created deposit-mode PaymentIntent.
 *
 *  Returns null (never throws) when the PI is not in the expected shape: wrong
 *  status, no next_action, no Base entry, OR a Base entry whose supported USDC
 *  token is not the pinned Base USDC contract (see below). The adapter maps null
 *  to a clean error rather than handing an agent a missing, wrong-network, or
 *  wrong-token address. */
export function extractBaseDepositAddress(
  pi: Stripe.PaymentIntent,
): { readonly address: string; readonly tokenContract: string } | null {
  // Cast seam #2: crypto_display_details is not in the stripe@22 NextAction type.
  const nextAction = pi.next_action as
    (Stripe.PaymentIntent.NextAction & { crypto_display_details?: CryptoDisplayDetails }) | null;
  const details = nextAction?.crypto_display_details;
  const entry = details?.deposit_addresses?.[DEPOSIT_NETWORK];
  if (entry === undefined || typeof entry.address !== "string" || entry.address === "") {
    return null;
  }
  // Bind the address to the pinned Base USDC contract. Handing out an address for
  // any other token (or one we cannot confirm) would let the agent pay a token
  // Stripe is not watching for at that address, stranding the funds with no
  // auto-return. A Base entry with no supported USDC token equal to
  // PINNED_BASE_USDC is refused: absent supported_tokens = cannot confirm = refuse.
  const usdcToken = entry.supported_tokens?.find(
    (t) =>
      t.token_currency?.toLowerCase() === DEPOSIT_TOKEN &&
      t.token_contract_address?.toLowerCase() === PINNED_BASE_USDC.toLowerCase(),
  );
  if (usdcToken === undefined) return null;
  return { address: entry.address, tokenContract: usdcToken.token_contract_address };
}

/** A provisioned deposit address plus the PaymentIntent it belongs to. */
export interface ProvisionedDeposit {
  readonly paymentIntentId: string;
  readonly address: string;
  readonly tokenContract: string | null;
  /** Address/PI validity horizon if Stripe exposes one on the created PI, else
   *  null. V4 (UNVERIFIED): the field and window are not yet confirmed against a
   *  live PI, so the caller must treat null as "unknown, bind the reservation
   *  conservatively" and NEVER as "unbounded." */
  readonly expiresAt: string | null;
}

export type ProvisionDepositResult =
  | { readonly ok: true; readonly value: ProvisionedDeposit }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/** Provision a per-order Base USDC deposit address by creating a deposit-mode
 *  PaymentIntent ON the merchant's connected account (direct charge). The returned
 *  address becomes the order's x402 payTo: the agent sends USDC to it exactly as
 *  it would to a merchant wallet, and on-chain settlement runs through the x402
 *  rail unchanged.
 *
 *  IDEMPOTENT on `idempotencyKey` (pass the checkout-session / reservation id): a
 *  retried provision returns Stripe's existing PI and address, so one order never
 *  mints two addresses (a double-pay hazard).
 *
 *  Always creates ON the connected account (forces onConnectedAccount=true). It
 *  REQUIRES input.applicationFeeMinor to be a finite non-negative integer and
 *  fails closed if it is absent or invalid: a positive value attaches the platform
 *  fee, and 0 means no fee as a DELIBERATE choice. A fee-less deposit can never be
 *  minted by an accidental omission, which would silently earn Facet nothing on
 *  the order.
 *
 *  Never throws: a Stripe failure is returned as { ok:false }. `retryable`
 *  separates a transient API/connection/rate error (caller may retry) from a
 *  definitive rejection (missing account, missing fee, unmatched response shape). */
export async function provisionDepositAddress(args: {
  readonly stripe: Stripe;
  readonly connectAccountId: string;
  readonly idempotencyKey: string;
  readonly input: DepositPaymentIntentInput;
}): Promise<ProvisionDepositResult> {
  const { stripe, connectAccountId, idempotencyKey, input } = args;
  if (typeof connectAccountId !== "string" || connectAccountId.trim() === "") {
    return {
      ok: false,
      reason: "deposit venue requires a connected account id",
      retryable: false,
    };
  }
  // Fail closed on a missing/invalid fee. The provisioner always runs on a
  // connected account, so the fee decision is mandatory: 0 is a deliberate no-fee,
  // absent is a caller bug that must not silently mint a fee-less (zero-revenue)
  // deposit. This makes the docstring's guarantee true rather than aspirational.
  if (
    typeof input.applicationFeeMinor !== "number" ||
    !Number.isFinite(input.applicationFeeMinor) ||
    !Number.isInteger(input.applicationFeeMinor) ||
    input.applicationFeeMinor < 0
  ) {
    return {
      ok: false,
      reason: "deposit venue requires an explicit non-negative integer applicationFeeMinor",
      retryable: false,
    };
  }
  const params = buildDepositPaymentIntentParams({ ...input, onConnectedAccount: true });
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(params, {
      idempotencyKey,
      stripeAccount: connectAccountId,
    });
  } catch (e) {
    const transient =
      e instanceof Stripe.errors.StripeAPIError ||
      e instanceof Stripe.errors.StripeConnectionError ||
      e instanceof Stripe.errors.StripeRateLimitError;
    return {
      ok: false,
      reason: `deposit PI create failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: transient,
    };
  }
  const extracted = extractBaseDepositAddress(pi);
  if (extracted === null) {
    return {
      ok: false,
      reason: `deposit PI ${pi.id} returned no Base deposit address (status ${pi.status})`,
      retryable: false,
    };
  }
  return {
    ok: true,
    value: {
      paymentIntentId: pi.id,
      address: extracted.address,
      tokenContract: extracted.tokenContract,
      expiresAt: null,
    },
  };
}
