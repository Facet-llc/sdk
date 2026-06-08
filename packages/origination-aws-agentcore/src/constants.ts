// AgentCore Payments — protocol constants. Ported line-for-line from the
// canonical Python SDK (github.com/aws/bedrock-agentcore-sdk-python). Keep
// this list in sync with the upstream `NETWORK_PREFERENCES` — the SDK uses it to pick
// the most-preferred chain when an x402 response advertises multiple
// `accepts` and we need to settle on one matching the instrument's chain
// (see `PaymentManager.generatePaymentHeader` for the selection logic).
//
// Ordering matters: Solana mainnet first (low fees + fast finality), then
// EVM mainnets (Base preferred), then testnets. Don't reorder without
// matching the upstream — it's part of the merchant-observable behavior.

/** Default network preference order for x402 `accepts` selection.
 *  Most-preferred first. Mirrors `NETWORK_PREFERENCES` in the canonical
 *  Python SDK. */
export const NETWORK_PREFERENCES: readonly string[] = [
  // Solana mainnet (low fee + fast)
  "solana-mainnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  // EVM mainnets
  "eip155:8453", // Base mainnet (low fees)
  "eip155:1", // Ethereum mainnet
  "base",
  "eip155:42161", // Arbitrum One
  "eip155:10", // Optimism
  "ethereum",
  // Solana testnets
  "solana-devnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "solana-testnet",
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  // EVM testnets
  "sepolia",
  "base-sepolia",
  "eip155:84532", // Base Sepolia
  "eip155:11155111", // Ethereum Sepolia
] as const;

/** EVM-family network identifiers — used to filter x402 `accepts` by
 *  blockchain family when the instrument is `ETHEREUM`. Sourced from the
 *  Python SDK's `_ETHEREUM_NETWORKS` set (lowercased for comparison). */
export const ETHEREUM_NETWORKS: ReadonlySet<string> = new Set([
  "eip155:8453",
  "eip155:1",
  "base",
  "eip155:42161",
  "eip155:10",
  "ethereum",
  "sepolia",
  "base-sepolia",
  "eip155:84532",
  "eip155:11155111",
]);

/** Solana-family network identifiers — used to filter x402 `accepts` by
 *  blockchain family when the instrument is `SOLANA`. Sourced from the
 *  Python SDK's `_SOLANA_NETWORKS` set (lowercased for comparison). */
export const SOLANA_NETWORKS: ReadonlySet<string> = new Set([
  "solana",
  "solana-mainnet",
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp",
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdpkuc147dw2n9d",
  "solana-devnet",
  "solana:etwtrabzayq6imfeykouru166vu2xqa1",
  "solana:etwtrabzayq6imfeykouru166vu2xqa1wcawoxpkrzbg",
  "solana-testnet",
  "solana:4uhcvjyu9pjkvqys88urdiswhxscky3z",
  "solana:4uhcvjyu9pjkvqys88urdiswhxscky3zqawwpjk2nsny",
]);

/** Default max-results for paginated list APIs. Matches the Python SDK's
 *  `DEFAULT_MAX_RESULTS`. */
export const DEFAULT_MAX_RESULTS = 100;

/** Payment connector type strings — mirrors `PaymentConnectorType` in
 *  the Python SDK. Use these literal values when calling
 *  `createPaymentInstrument`. */
export const PaymentConnectorType = {
  COINBASE_CDP: "CoinbaseCDP",
  STRIPE_PRIVY: "StripePrivy",
} as const;
export type PaymentConnectorType = (typeof PaymentConnectorType)[keyof typeof PaymentConnectorType];

/** AgentCore custom HTTP headers — the Python SDK injects these on every
 *  data-plane call via a boto3 `before-sign` event hook. In TS we apply
 *  them via SDK JS middleware (see `payment-manager.ts`). */
export const AGENT_NAME_HEADER = "X-Amzn-Bedrock-AgentCore-Payments-Agent-Name";
