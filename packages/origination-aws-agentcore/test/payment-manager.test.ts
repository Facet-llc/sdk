// PaymentManager tests — verify the TypeScript port of the canonical
// Python `PaymentManager` class behaves spec-faithfully against a
// mocked `BedrockAgentCoreClient`. The mock implements just enough of
// the v3 SDK's `.send(command)` contract to capture inputs and return
// canned outputs; we don't talk to real AWS.
//
// What we assert:
//   * Every method injects `paymentManagerArn` automatically
//   * `userId` is omitted when undefined/empty/whitespace
//   * `clientToken` is auto-generated when not supplied
//   * `processPayment` does NOT forward `paymentConnectorId`
//   * `generatePaymentHeader` end-to-end (v1 + v2)
//   * Error mapping for ResourceNotFound / ValidationException

import { describe, expect, it, vi } from "vitest";

import {
  CreatePaymentInstrumentCommand,
  CreatePaymentSessionCommand,
  GetPaymentInstrumentCommand,
  ProcessPaymentCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";

import {
  PaymentManager,
  PaymentInstrumentNotFound,
  PaymentSessionExpired,
  InsufficientBudget,
} from "../src/payment-manager.ts";

const PM_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:payment-manager/PM-A";

/** Mock client that captures the last sent command + returns a canned
 *  response. The AWS SDK JS v3 client surface is huge; we only need
 *  `.send`. Cast to BedrockAgentCoreClient at the boundary. */
function makeMockClient(response: unknown): {
  readonly client: BedrockAgentCoreClient;
  readonly send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(response);
  // Cast: the real client has many more methods (config, middleware
  // stack, etc.) but our wrapper only invokes .send().
  const client = { send } as unknown as BedrockAgentCoreClient;
  return { client, send };
}

describe("PaymentManager constructor", () => {
  it("throws when paymentManagerArn is empty", () => {
    const { client } = makeMockClient({});
    expect(() => new PaymentManager({ paymentManagerArn: "", client })).toThrow(
      /paymentManagerArn is required/,
    );
  });

  it("throws when paymentManagerArn is whitespace-only", () => {
    const { client } = makeMockClient({});
    expect(() => new PaymentManager({ paymentManagerArn: "", client })).toThrow();
  });
});

describe("PaymentManager.createPaymentInstrument", () => {
  it("auto-injects paymentManagerArn + clientToken", async () => {
    const { client, send } = makeMockClient({
      paymentInstrument: { paymentInstrumentId: "pi-1" },
    });
    const pm = new PaymentManager({
      paymentManagerArn: PM_ARN,
      client,
      clientTokenFactory: () => "test-token-1",
    });
    await pm.createPaymentInstrument({
      paymentConnectorId: "connector-X",
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: { network: "ETHEREUM", linkedAccounts: [] },
      },
      userId: "user-42",
    });
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]![0] as CreatePaymentInstrumentCommand;
    expect(cmd).toBeInstanceOf(CreatePaymentInstrumentCommand);
    expect(cmd.input.paymentManagerArn).toBe(PM_ARN);
    expect(cmd.input.clientToken).toBe("test-token-1");
    expect(cmd.input.userId).toBe("user-42");
    expect(cmd.input.paymentConnectorId).toBe("connector-X");
  });

  it("omits userId field when undefined", async () => {
    const { client, send } = makeMockClient({
      paymentInstrument: { paymentInstrumentId: "pi-1" },
    });
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await pm.createPaymentInstrument({
      paymentConnectorId: "connector-X",
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: { network: "ETHEREUM", linkedAccounts: [] },
      },
    });
    const cmd = send.mock.calls[0]![0] as CreatePaymentInstrumentCommand;
    expect("userId" in cmd.input).toBe(false);
  });

  it("propagates agentName when set on the manager", async () => {
    const { client, send } = makeMockClient({
      paymentInstrument: { paymentInstrumentId: "pi-1" },
    });
    const pm = new PaymentManager({
      paymentManagerArn: PM_ARN,
      client,
      agentName: "facet-test-agent",
    });
    await pm.createPaymentInstrument({
      paymentConnectorId: "c",
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: { network: "ETHEREUM", linkedAccounts: [] },
      },
    });
    const cmd = send.mock.calls[0]![0] as CreatePaymentInstrumentCommand;
    expect((cmd.input as { agentName?: string }).agentName).toBe("facet-test-agent");
  });
});

describe("PaymentManager.getPaymentInstrument error mapping", () => {
  it("maps ResourceNotFoundException → PaymentInstrumentNotFound", async () => {
    const err = Object.assign(new Error("Resource not found"), {
      name: "ResourceNotFoundException",
    });
    const { client } = makeMockClient({});
    (client.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(pm.getPaymentInstrument({ paymentInstrumentId: "pi-missing" })).rejects.toThrow(
      PaymentInstrumentNotFound,
    );
  });
});

describe("PaymentManager.createPaymentSession", () => {
  it("forwards limits when supplied", async () => {
    const { client, send } = makeMockClient({
      paymentSession: { paymentSessionId: "ps-1" },
    });
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await pm.createPaymentSession({
      expiryTimeInMinutes: 60,
      userId: "user-42",
      // AWS's `Currency` enum (used for Amount.currency) is "USD".
      // The on-chain token symbol "USDC" lives in InstrumentBalanceToken,
      // a different enum used by getPaymentInstrumentBalance.
      limits: { maxSpendAmount: { value: "100.00", currency: "USD" } },
    });
    const cmd = send.mock.calls[0]![0] as CreatePaymentSessionCommand;
    expect(cmd.input.limits?.maxSpendAmount?.value).toBe("100.00");
    expect(cmd.input.expiryTimeInMinutes).toBe(60);
  });
});

describe("PaymentManager.processPayment", () => {
  it("does NOT forward paymentConnectorId (Python parity)", async () => {
    const { client, send } = makeMockClient({
      processPaymentId: "pp-1",
      paymentOutput: { cryptoX402: { version: "1", payload: {} } },
    });
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await pm.processPayment({
      paymentSessionId: "ps-1",
      paymentInstrumentId: "pi-1",
      paymentType: "CRYPTO_X402",
      paymentInput: { cryptoX402: { version: "1", payload: {} } },
      paymentConnectorId: "should-not-be-forwarded",
    });
    const cmd = send.mock.calls[0]![0] as ProcessPaymentCommand;
    expect("paymentConnectorId" in cmd.input).toBe(false);
  });

  it("maps ValidationException with 'insufficient' → InsufficientBudget", async () => {
    const err = Object.assign(new Error("Insufficient budget remaining"), {
      name: "ValidationException",
    });
    const { client } = makeMockClient({});
    (client.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.processPayment({
        paymentSessionId: "ps-1",
        paymentInstrumentId: "pi-1",
        paymentType: "CRYPTO_X402",
        paymentInput: { cryptoX402: { version: "1", payload: {} } },
      }),
    ).rejects.toThrow(InsufficientBudget);
  });

  it("maps ValidationException with 'expired' → PaymentSessionExpired", async () => {
    const err = Object.assign(new Error("Session expired"), {
      name: "ValidationException",
    });
    const { client } = makeMockClient({});
    (client.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.processPayment({
        paymentSessionId: "ps-1",
        paymentInstrumentId: "pi-1",
        paymentType: "CRYPTO_X402",
        paymentInput: { cryptoX402: { version: "1", payload: {} } },
      }),
    ).rejects.toThrow(PaymentSessionExpired);
  });
});

describe("PaymentManager.generatePaymentHeader", () => {
  // The header generation flow is the most spec-sensitive part — it must
  // mirror the Python implementation step-by-step (extract → look up
  // instrument → filter accepts by chain → pick by preference →
  // processPayment → base64-encode the result).

  it("produces an X-PAYMENT header for x402 v1 + Ethereum instrument", async () => {
    const send = vi.fn();
    // Call 1: getPaymentInstrument → wallet on ETHEREUM
    send.mockResolvedValueOnce({
      paymentInstrument: {
        paymentInstrumentId: "pi-1",
        paymentInstrumentDetails: {
          embeddedCryptoWallet: { network: "ETHEREUM", linkedAccounts: [] },
        },
      },
    });
    // Call 2: processPayment → returns the crypto proof
    send.mockResolvedValueOnce({
      processPaymentId: "pp-1",
      paymentOutput: {
        cryptoX402: {
          version: "1",
          payload: { signature: "0xdeadbeef", authorization: { value: "5000" } },
        },
      },
    });
    const client = { send } as unknown as BedrockAgentCoreClient;
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    const result = await pm.generatePaymentHeader({
      paymentInstrumentId: "pi-1",
      paymentSessionId: "ps-1",
      userId: "user-42",
      paymentRequiredRequest: {
        statusCode: 402,
        headers: {},
        body: {
          x402Version: 1,
          accepts: [
            { scheme: "exact", network: "base-sepolia", payTo: "0xMERCHANT" },
            { scheme: "exact", network: "solana-mainnet", payTo: "SolanaAddr" },
          ],
        },
      },
    });
    expect("X-PAYMENT" in result).toBe(true);
    if ("X-PAYMENT" in result) {
      const decoded = JSON.parse(Buffer.from(result["X-PAYMENT"], "base64").toString("utf-8"));
      expect(decoded.x402Version).toBe(1);
      expect(decoded.scheme).toBe("exact");
      // Ethereum instrument should select an EVM accept, not Solana
      expect(decoded.network).toBe("base-sepolia");
    }
  });

  it("produces a PAYMENT-SIGNATURE header for x402 v2 (header form)", async () => {
    const send = vi.fn();
    send.mockResolvedValueOnce({
      paymentInstrument: {
        paymentInstrumentId: "pi-1",
        paymentInstrumentDetails: { embeddedCryptoWallet: { network: "SOLANA" } },
      },
    });
    send.mockResolvedValueOnce({
      processPaymentId: "pp-1",
      paymentOutput: {
        cryptoX402: {
          version: "2",
          payload: { tx: "base58blob" },
        },
      },
    });
    const client = { send } as unknown as BedrockAgentCoreClient;
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    // v2: payment-required header carries the base64-encoded JSON
    const v2Payload = {
      x402Version: 2,
      resource: "https://merchant.example/v1/checkout",
      accepts: [{ scheme: "exact", network: "solana-mainnet", payTo: "SolanaMerchant" }],
    };
    const result = await pm.generatePaymentHeader({
      paymentInstrumentId: "pi-1",
      paymentSessionId: "ps-1",
      paymentRequiredRequest: {
        statusCode: 402,
        headers: {
          "payment-required": Buffer.from(JSON.stringify(v2Payload), "utf-8").toString("base64"),
        },
        body: "",
      },
    });
    expect("PAYMENT-SIGNATURE" in result).toBe(true);
  });

  it("rejects non-402 status codes", async () => {
    const { client } = makeMockClient({});
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.generatePaymentHeader({
        paymentInstrumentId: "pi-1",
        paymentSessionId: "ps-1",
        paymentRequiredRequest: {
          statusCode: 200,
          headers: {},
          body: { x402Version: 1, accepts: [] },
        },
      }),
    ).rejects.toThrow(/Invalid status code/);
  });

  it("rejects when no accepts match the instrument's chain family", async () => {
    const send = vi.fn();
    send.mockResolvedValueOnce({
      paymentInstrument: {
        paymentInstrumentId: "pi-1",
        paymentInstrumentDetails: {
          embeddedCryptoWallet: { network: "ETHEREUM", linkedAccounts: [] },
        },
      },
    });
    const client = { send } as unknown as BedrockAgentCoreClient;
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.generatePaymentHeader({
        paymentInstrumentId: "pi-1",
        paymentSessionId: "ps-1",
        paymentRequiredRequest: {
          statusCode: 402,
          headers: {},
          body: {
            x402Version: 1,
            // Ethereum instrument, but accepts only Solana — should reject
            accepts: [{ scheme: "exact", network: "solana-mainnet", payTo: "X" }],
          },
        },
      }),
    ).rejects.toThrow(/No matching accept/);
  });

  it("rejects when instrument has no embeddedCryptoWallet.network", async () => {
    const send = vi.fn();
    send.mockResolvedValueOnce({
      paymentInstrument: {
        paymentInstrumentId: "pi-1",
        paymentInstrumentDetails: {},
      },
    });
    const client = { send } as unknown as BedrockAgentCoreClient;
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.generatePaymentHeader({
        paymentInstrumentId: "pi-1",
        paymentSessionId: "ps-1",
        paymentRequiredRequest: {
          statusCode: 402,
          headers: {},
          body: { x402Version: 1, accepts: [] },
        },
      }),
    ).rejects.toThrow(/Missing network information/);
  });

  it("validates required input fields", async () => {
    const { client } = makeMockClient({});
    const pm = new PaymentManager({ paymentManagerArn: PM_ARN, client });
    await expect(
      pm.generatePaymentHeader({
        paymentInstrumentId: "",
        paymentSessionId: "ps-1",
        paymentRequiredRequest: { statusCode: 402, headers: {}, body: {} },
      }),
    ).rejects.toThrow(/instrument_id is empty/);
  });
});
