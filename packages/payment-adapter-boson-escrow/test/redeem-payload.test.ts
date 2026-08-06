// validateRedeemPayload — proven against REAL SDK-produced payloads.
//
// Every fixture here is signed with the same primitives that produce a live
// buyer's redeem (metaTransactionExchangeTypedData + encodeSignedPayload), so
// these tests pin the actual wire contract rather than a hand-rolled mock of it.
// The happy path is the load-bearing one: a validator that refused a genuine
// redeem would strand escrow far more often than any attack.

import { encodeSignedPayload } from "@bosonprotocol/x402-evm/codec";
import { metaTransactionExchangeTypedData } from "@bosonprotocol/x402-core/eip712";
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type DisputeMetaTxAction,
  validateDisputePayload,
  validateRedeemPayload,
} from "../src/redeem-payload.ts";

const DIAMOND: Address = "0x000000000000000000000000000000000000d1a3";
const CHAIN_ID = 8453; // Base mainnet
const REDEEM_ABI = parseAbi(["function redeemVoucher(uint256 _exchangeId)"]);

const BUYER = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const ATTACKER = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);

/** Produce a real signed payload exactly as a buyer's wallet would. */
async function buildPayload(opts: {
  account: typeof BUYER;
  exchangeId: bigint;
  /** Override to smuggle a different MetaTxExchange action through. */
  functionName?: string;
  /** Override the exchange id encoded in the CALLDATA only, desyncing it from
   *  the signed struct. */
  calldataExchangeId?: bigint;
}): Promise<string> {
  const functionName = opts.functionName ?? "redeemVoucher(uint256)";
  const typedData = await metaTransactionExchangeTypedData({
    chainId: CHAIN_ID,
    verifyingContract: DIAMOND,
    nonce: 7n,
    from: opts.account.address,
    functionName,
    exchangeId: opts.exchangeId,
  });
  // deno-lint-ignore no-explicit-any
  const signature = await opts.account.signTypedData(typedData as any);
  return encodeSignedPayload({
    from: opts.account.address,
    nonce: "7",
    functionName,
    functionSignature: encodeFunctionData({
      abi: REDEEM_ABI,
      functionName: "redeemVoucher",
      args: [opts.calldataExchangeId ?? opts.exchangeId],
    }),
    sig: {
      v: parseInt(signature.slice(130, 132), 16),
      r: signature.slice(0, 66) as Hex,
      s: `0x${signature.slice(66, 130)}` as Hex,
    },
  });
}

const validate = (signedPayload: string, exchangeId: string) =>
  validateRedeemPayload({
    signedPayload,
    exchangeId,
    chainId: CHAIN_ID,
    verifyingContract: DIAMOND,
  });

describe("validateRedeemPayload", () => {
  it("accepts a genuine buyer-signed redeem for its own exchange", async () => {
    const payload = await buildPayload({ account: BUYER, exchangeId: 42n });
    const result = await validate(payload, "42");
    expect(result.ok).toBe(true);
    expect(result.signer?.toLowerCase()).toBe(BUYER.address.toLowerCase());
  });

  it("refuses a real payload filed against a DIFFERENT exchange", async () => {
    // The payload is genuine, but it redeems exchange 42. Storing it against 99
    // would leave 99 holding bytes that can never release it.
    const payload = await buildPayload({ account: BUYER, exchangeId: 42n });
    const result = await validate(payload, "99");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exchange_id_mismatch");
  });

  it("refuses a non-redeem action sharing the MetaTxExchange struct", async () => {
    // cancelVoucher signs over the same struct. Accepted as a redeem it would
    // CANCEL the exchange instead of paying the merchant.
    const payload = await buildPayload({
      account: BUYER,
      exchangeId: 42n,
      functionName: "cancelVoucher(uint256)",
    });
    const result = await validate(payload, "42");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_redeem");
  });

  it("refuses calldata desynced from the signed exchange id", async () => {
    // Signed struct says 42, calldata says 99: the Diamond acts on the calldata,
    // so trusting the struct alone would redeem the wrong exchange.
    const payload = await buildPayload({
      account: BUYER,
      exchangeId: 42n,
      calldataExchangeId: 99n,
    });
    const result = await validate(payload, "42");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exchange_id_mismatch");
  });

  it("refuses undecodable bytes rather than throwing", async () => {
    // A malformed submission must be a 4xx at the route, never a 500.
    const result = await validate("0xdeadbeef", "42");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("payload_undecodable");
  });

  it("does NOT establish that the signer owns the exchange (authorization is the caller's job)", async () => {
    // LOAD-BEARING NEGATIVE TEST. An attacker can sign a well-formed redeem naming
    // their OWN address against a VICTIM's exchange id, and it passes every check
    // here: the signature recovers to its own `from` consistently. It is useless
    // on-chain, but storing it displaces the real payload and strands the escrow.
    // This test exists so nobody reads the validator as an authorization boundary
    // and drops the ownership bind the route performs. If this ever starts
    // returning ok:false, the validator gained a buyer check and the comment in
    // redeem-payload.ts must be updated to match.
    const payload = await buildPayload({ account: ATTACKER, exchangeId: 42n });
    const result = await validate(payload, "42");
    expect(result.ok).toBe(true);
    expect(result.signer?.toLowerCase()).toBe(ATTACKER.address.toLowerCase());
  });
});

// The three buyer-only dispute actions share the redeem/cancel MetaTxExchange
// struct family (core-sdk signs them via makeExchangeMetaTxSigner), so the same
// self-binding validation applies — only the function name differs. resolve is
// NOT here (a different, counterparty-signed struct). Explicit const ABIs so viem
// infers the literal argument types (a dynamic parseAbi widens `abi` to `never`).
const RAISE_ABI = parseAbi(["function raiseDispute(uint256 _exchangeId)"]);
const RETRACT_ABI = parseAbi(["function retractDispute(uint256 _exchangeId)"]);
const ESCALATE_ABI = parseAbi(["function escalateDispute(uint256 _exchangeId)"]);
const DISPUTE_FUNCTION_NAME: Record<DisputeMetaTxAction, string> = {
  raise: "raiseDispute(uint256)",
  retract: "retractDispute(uint256)",
  escalate: "escalateDispute(uint256)",
};

function disputeCalldata(action: DisputeMetaTxAction, exchangeId: bigint): Hex {
  switch (action) {
    case "raise":
      return encodeFunctionData({
        abi: RAISE_ABI,
        functionName: "raiseDispute",
        args: [exchangeId],
      });
    case "retract":
      return encodeFunctionData({
        abi: RETRACT_ABI,
        functionName: "retractDispute",
        args: [exchangeId],
      });
    case "escalate":
      return encodeFunctionData({
        abi: ESCALATE_ABI,
        functionName: "escalateDispute",
        args: [exchangeId],
      });
  }
}

/** A real buyer-signed dispute meta-tx for `action`, built exactly as a wallet's
 *  makeExchangeMetaTxSigner would. */
async function buildDisputePayload(opts: {
  account: typeof BUYER;
  action: DisputeMetaTxAction;
  exchangeId: bigint;
  calldataExchangeId?: bigint;
}): Promise<string> {
  const functionName = DISPUTE_FUNCTION_NAME[opts.action];
  const typedData = await metaTransactionExchangeTypedData({
    chainId: CHAIN_ID,
    verifyingContract: DIAMOND,
    nonce: 7n,
    from: opts.account.address,
    functionName,
    exchangeId: opts.exchangeId,
  });
  // deno-lint-ignore no-explicit-any
  const signature = await opts.account.signTypedData(typedData as any);
  return encodeSignedPayload({
    from: opts.account.address,
    nonce: "7",
    functionName,
    functionSignature: disputeCalldata(opts.action, opts.calldataExchangeId ?? opts.exchangeId),
    sig: {
      v: parseInt(signature.slice(130, 132), 16),
      r: signature.slice(0, 66) as Hex,
      s: `0x${signature.slice(66, 130)}` as Hex,
    },
  });
}

describe("validateDisputePayload", () => {
  const ACTIONS: DisputeMetaTxAction[] = ["raise", "retract", "escalate"];

  for (const action of ACTIONS) {
    it(`accepts a genuine buyer-signed ${action} for its own exchange`, async () => {
      const payload = await buildDisputePayload({ account: BUYER, action, exchangeId: 42n });
      const result = await validateDisputePayload({
        signedPayload: payload,
        exchangeId: "42",
        chainId: CHAIN_ID,
        verifyingContract: DIAMOND,
        action,
      });
      expect(result.ok).toBe(true);
      expect(result.signer?.toLowerCase()).toBe(BUYER.address.toLowerCase());
    });
  }

  it("refuses a dispute filed against a DIFFERENT exchange", async () => {
    const payload = await buildDisputePayload({ account: BUYER, action: "raise", exchangeId: 42n });
    const result = await validateDisputePayload({
      signedPayload: payload,
      exchangeId: "99",
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND,
      action: "raise",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exchange_id_mismatch");
  });

  it("refuses a payload whose action does not match the requested one", async () => {
    // A retract payload submitted as a raise: the on-chain effect would differ
    // from the action the Terminal authorized.
    const payload = await buildDisputePayload({
      account: BUYER,
      action: "retract",
      exchangeId: 42n,
    });
    const result = await validateDisputePayload({
      signedPayload: payload,
      exchangeId: "42",
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND,
      action: "raise",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_dispute");
  });

  it("refuses a non-dispute action (a redeem) smuggled as a dispute", async () => {
    const payload = await buildPayload({ account: BUYER, exchangeId: 42n });
    const result = await validateDisputePayload({
      signedPayload: payload,
      exchangeId: "42",
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND,
      action: "raise",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_dispute");
  });

  it("refuses calldata desynced from the signed exchange id", async () => {
    const payload = await buildDisputePayload({
      account: BUYER,
      action: "raise",
      exchangeId: 42n,
      calldataExchangeId: 99n,
    });
    const result = await validateDisputePayload({
      signedPayload: payload,
      exchangeId: "42",
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND,
      action: "raise",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exchange_id_mismatch");
  });

  it("refuses undecodable bytes rather than throwing", async () => {
    const result = await validateDisputePayload({
      signedPayload: "0xdeadbeef",
      exchangeId: "42",
      chainId: CHAIN_ID,
      verifyingContract: DIAMOND,
      action: "raise",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("payload_undecodable");
  });
});
