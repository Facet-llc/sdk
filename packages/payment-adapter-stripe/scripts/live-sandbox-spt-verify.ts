// Live Stripe TEST-MODE sandbox verification for the ACP Shared Payment
// Token redemption call built in adapter.ts's buildCreateParamsForDelegatedPayment
// (see third_party/acp-spec/FACET-ACP-ANALYSIS.md section 5a). Every unit
// test for this path is a mock; this is the one check that actually hits
// Stripe's real test-mode API with a real test-mode key and a real minted
// SPT, exercising the exact call shape production code sends.
//
// SAFETY: this script refuses to run unless the configured key's prefix is
// literally "sk_test_". It never logs the secret key, the minted SPT id, or
// the resulting PaymentIntent id in full: only a short prefix plus length,
// enough to confirm shape without disclosing the value. Run only via
// Doppler so the key never appears as a literal argument or in shell
// history:
//
//   cd packages/payment-adapter-stripe
//   doppler run -p facet-terminal -c prd -- \
//     pnpm exec vitest run --config scripts/live-sandbox-spt-verify.vitest.config.ts
//
// The scoped --config is required: this filename deliberately does NOT
// match vitest's default test include glob (**/*.{test,spec}.ts), so a
// bare `pnpm test` or `pnpm exec vitest run` never picks up this
// live-network, real-secret-dependent script by accident. Passing an
// explicit file path to `vitest run` still filters WITHIN the default
// include glob rather than adding a new file outside it, hence the
// sibling live-sandbox-spt-verify.vitest.config.ts that overrides
// `include` for this one invocation only.
//
// FACET_MERCH_STRIPE_SECRET_KEY (facet-terminal/prd), not
// FACET_STRIPE_SECRET_KEY, is the confirmed test-mode credential for this
// check: verify the prefix yourself before ever relying on that
// assumption again (`doppler secrets get NAME --plain -p facet-terminal
// -c prd 2>/dev/null | cut -c1-8`, redirecting stderr to /dev/null, never
// merging it with 2>&1, which can concatenate an informational warning
// onto the real secret value on stdout).

import { it } from "vitest";
import { StripeAdapter } from "../src/adapter.ts";

function redact(value: string, keep = 6): string {
  return `${value.slice(0, keep)}… (${value.length} chars)`;
}

it(
  "live sandbox: redeems a real Stripe test-mode Shared Payment Token through StripeAdapter.verifyAuthority",
  { timeout: 30_000 },
  async () => {
    const apiKey = process.env["FACET_MERCH_STRIPE_SECRET_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "FACET_MERCH_STRIPE_SECRET_KEY is not set. Run this via " +
          "`doppler run -p facet-terminal -c prd -- pnpm exec vitest run scripts/live-sandbox-spt-verify.ts` " +
          "so the key is injected into the process environment, never passed as a literal argument.",
      );
    }
    if (!apiKey.startsWith("sk_test_")) {
      throw new Error(
        "Refusing to run: FACET_MERCH_STRIPE_SECRET_KEY does not start with sk_test_. " +
          "This script only ever runs against a confirmed Stripe TEST-mode key.",
      );
    }
    console.log(`Using Stripe key: ${redact(apiKey)}`);

    // Step 1: mint a real test SPT via Stripe's test-helper endpoint. Call
    // shape confirmed from docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
    // (Sellers variant), fetched 2026-08-05, not guessed.
    const grantResponse = await fetch(
      "https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
          "Stripe-Version": "2026-04-22.preview",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          payment_method: "pm_card_visa",
          "usage_limits[currency]": "usd",
          "usage_limits[max_amount]": "2500",
          "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + 3600),
        }).toString(),
      },
    );
    const grantBody = (await grantResponse.json()) as Record<string, unknown>;
    if (!grantResponse.ok) {
      throw new Error(
        `Stripe test_helpers/shared_payment/granted_tokens failed: ${grantResponse.status} ${JSON.stringify(
          grantBody,
        )}`,
      );
    }
    const sptId = grantBody["id"];
    if (typeof sptId !== "string" || !sptId.startsWith("spt_")) {
      throw new Error(
        `Expected a spt_ id in the grant response, got: ${JSON.stringify(grantBody)}`,
      );
    }
    console.log(`Minted test SPT: ${redact(sptId, 4)}`);

    // Step 2: run the REAL production redemption path. This is the exact
    // public method bridgeAcpCheckoutCredential's authority flows into,
    // with no test-only shortcut: StripeAdapter.verifyAuthority reads
    // authority.delegated_payment_token, builds the PaymentIntent create
    // params via buildCreateParamsForDelegatedPayment (the function this
    // whole check exists to verify), and calls the real Stripe API.
    const adapter = new StripeAdapter();
    const result = await adapter.verifyAuthority({
      ctx: {
        trace_id: `live-sandbox-verify-${Date.now()}`,
        idempotency_key: `live-sandbox-verify-${Date.now()}`,
        merchant_id: "live-sandbox-verify",
        site_id: "live-sandbox-verify",
        received_at: new Date().toISOString(),
      },
      merchant_config: { api_key: apiKey },
      authority: { delegated_payment_token: sptId },
      amount: { amount: 2500, currency: "USD" },
    });

    if (result.kind !== "ok") {
      throw new Error(`verifyAuthority did not succeed: ${JSON.stringify(result)}`);
    }
    console.log(
      `verifyAuthority OK. authority_handle: ${redact(result.value.authority_handle, 4)}`,
    );

    // Step 3: confirm the PaymentIntent actually landed in Stripe as
    // requires_capture (authorized, not auto-captured), matching the
    // deliberate capture_method:"manual" choice in
    // buildCreateParamsForDelegatedPayment, then cancel it so the test
    // account is not left with a lingering authorized charge.
    const piResponse = await fetch(
      `https://api.stripe.com/v1/payment_intents/${result.value.authority_handle}`,
      { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` } },
    );
    const pi = (await piResponse.json()) as Record<string, unknown>;
    console.log(`PaymentIntent status: ${String(pi["status"])}`);
    if (pi["status"] !== "requires_capture") {
      throw new Error(
        `Expected PaymentIntent status "requires_capture" (manual-capture authorization), got "${String(
          pi["status"],
        )}"`,
      );
    }

    const cancelResponse = await fetch(
      `https://api.stripe.com/v1/payment_intents/${result.value.authority_handle}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      },
    );
    if (!cancelResponse.ok) {
      console.log(
        "Warning: cleanup cancel of the test PaymentIntent failed (non-fatal, test-mode only).",
      );
    } else {
      console.log("Test PaymentIntent canceled (cleanup).");
    }

    console.log(
      "\nPASS: a real Stripe test-mode Shared Payment Token was minted and redeemed end to end " +
        "through the production StripeAdapter.verifyAuthority code path, authorized with " +
        "capture_method=manual as designed, then cleaned up.",
    );
  },
);
