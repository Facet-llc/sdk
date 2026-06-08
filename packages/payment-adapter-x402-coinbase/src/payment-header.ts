// X-PAYMENT header decoder. The x402 SDK exposes verify/settle that take
// a PaymentPayload (already-parsed), but doesn't expose a public helper
// for "take the raw base64 header value and give me a typed payload".
// This is the merchant-side entry point — it turns whatever the agent
// put in `X-PAYMENT` into something we can hand to the SDK.

import { PaymentPayloadSchema, type PaymentPayload } from "x402/types";

export type DecodeResult =
  | { readonly kind: "ok"; readonly payload: PaymentPayload }
  | { readonly kind: "error"; readonly reason: string };

export function decodePaymentHeader(headerValue: string): DecodeResult {
  let decoded: string;
  try {
    decoded = atob(headerValue);
  } catch {
    return { kind: "error", reason: "X-PAYMENT header is not valid base64" };
  }

  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    return { kind: "error", reason: "X-PAYMENT payload is not valid JSON" };
  }

  const parsed = PaymentPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "error",
      reason: `X-PAYMENT payload does not match x402 schema: ${parsed.error.message}`,
    };
  }

  return { kind: "ok", payload: parsed.data };
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return btoa(JSON.stringify(payload));
}
