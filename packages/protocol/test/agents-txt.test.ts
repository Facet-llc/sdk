import { describe, expect, it } from "vitest";
import { AgentsTxtError, parseAgentsTxt } from "../src/index.ts";

// Examples copied verbatim from specs/agents.txt.md §5.
const EXAMPLE_1 = `# /.well-known/agents.txt
Facet-Version: 0.2
Terminal: https://facet.acme-ingredients.com/v1
KYA-Issuers: https://issuer.skyfire.xyz, https://kya.acme-ingredients.com
Pricing-Hint: 0.001 USDC/query, 0.01 USDC/transactional
Rate-Limit: 5000/hour
Reputation-Minimum: 70
Contact: agents@acme-ingredients.com
`;

const EXAMPLE_2 = `# /.well-known/agents.txt
Facet-Version: 0.2
Terminal: https://facet.legacyco-mfg.com/v1
KYA-Issuers: https://issuer.skyfire.xyz
Pricing-Hint: 0.005 USDC/query, 0.05 USDC/transactional
Rate-Limit: 500/hour
Reputation-Minimum: 85
Contact: operations@legacyco-mfg.com

[catalog]
Schema-Version: 1.2
Last-Updated: 2026-04-15T00:00:00Z
`;

const EXAMPLE_3 = `# /.well-known/agents.txt
Facet-Version: 0.2
Terminal: https://facet.beveragecp.com/v1
KYA-Issuers: https://issuer.skyfire.xyz
Alt-Identity: DID
Pricing-Hint: 0.002 USDC/query, 0.02 USDC/transactional
Rate-Limit: 2000/hour
Reputation-Minimum: 75
Contact: orders@beveragecp.com

[edi]
X12-Version: 4010
Order-Endpoint: https://facet.beveragecp.com/v1/edi/850
`;

describe("parseAgentsTxt v0.2", () => {
  it("parses example 1 — Shopify-backed ingredient distributor", () => {
    const m = parseAgentsTxt(EXAMPLE_1);
    expect(m.facetVersion).toBe("0.2");
    expect(m.terminal).toBe("https://facet.acme-ingredients.com/v1");
    expect(m.kyaIssuers).toEqual([
      "https://issuer.skyfire.xyz",
      "https://kya.acme-ingredients.com",
    ]);
    expect(m.pricingHint).toBe("0.001 USDC/query, 0.01 USDC/transactional");
    expect(m.rateLimit).toBe("5000/hour");
    expect(m.reputationMinimum).toBe(70);
    expect(m.contact).toBe("agents@acme-ingredients.com");
    expect(m.altIdentity).toBeUndefined();
    expect(m.sections).toEqual({});
    expect(m.unknownFields).toEqual({});
  });

  it("parses example 2 — legacy co-manufacturer with [catalog] section", () => {
    const m = parseAgentsTxt(EXAMPLE_2);
    expect(m.sections.catalog).toEqual({
      "schema-version": "1.2",
      "last-updated": "2026-04-15T00:00:00Z",
    });
  });

  it("parses example 3 — beverage co-packer with DID alt-identity and [edi] section", () => {
    const m = parseAgentsTxt(EXAMPLE_3);
    expect(m.altIdentity).toBe("DID");
    expect(m.sections.edi).toEqual({
      "x12-version": "4010",
      "order-endpoint": "https://facet.beveragecp.com/v1/edi/850",
    });
  });

  it("rejects missing required fields", () => {
    expect(() => parseAgentsTxt("Facet-Version: 0.2\nTerminal: https://x/v1\n")).toThrow(
      AgentsTxtError,
    );
    expect(() => parseAgentsTxt("Terminal: https://x/v1\nKYA-Issuers: https://i\n")).toThrow(
      /facet-version/,
    );
  });

  it("accepts non-strict mode for partial input", () => {
    const m = parseAgentsTxt("Facet-Version: 0.2\n", { strict: false });
    expect(m.facetVersion).toBe("0.2");
    expect(m.terminal).toBe("");
    expect(m.kyaIssuers).toEqual([]);
  });

  it("strips leading UTF-8 BOM", () => {
    const input = "\uFEFFFacet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\n";
    expect(() => parseAgentsTxt(input)).not.toThrow();
  });

  it("normalizes field-key case", () => {
    const m = parseAgentsTxt(
      "facet-version: 0.2\nTERMINAL: https://x/v1\nKya-Issuers: https://i\n",
    );
    expect(m.facetVersion).toBe("0.2");
    expect(m.terminal).toBe("https://x/v1");
    expect(m.kyaIssuers).toEqual(["https://i"]);
  });

  it("preserves unknown top-level keys for forward compat", () => {
    const m = parseAgentsTxt(
      "Facet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\nExperimental-Feature: on\n",
    );
    expect(m.unknownFields).toEqual({ "experimental-feature": "on" });
  });

  it("accepts unknown [sections] without failing", () => {
    const input =
      "Facet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\n\n[mystery]\nfoo: bar\n";
    const m = parseAgentsTxt(input);
    expect(m.sections.mystery).toEqual({ foo: "bar" });
  });

  it("handles CRLF line endings", () => {
    const input = "Facet-Version: 0.2\r\nTerminal: https://x/v1\r\nKYA-Issuers: https://i\r\n";
    expect(() => parseAgentsTxt(input)).not.toThrow();
  });

  it("rejects malformed lines in strict mode", () => {
    const input =
      "Facet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\nno-colon-here\n";
    expect(() => parseAgentsTxt(input)).toThrow(/Malformed line/);
  });

  it("rejects invalid Alt-Identity value in strict mode", () => {
    const input =
      "Facet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\nAlt-Identity: UNKNOWN\n";
    expect(() => parseAgentsTxt(input)).toThrow(/Alt-Identity/);
  });

  it("rejects Reputation-Minimum out of 0..100 range", () => {
    const input =
      "Facet-Version: 0.2\nTerminal: https://x/v1\nKYA-Issuers: https://i\nReputation-Minimum: 200\n";
    expect(() => parseAgentsTxt(input)).toThrow(/Reputation-Minimum/);
  });

  it("handles values that contain colons (splits only on the first)", () => {
    const input =
      "Facet-Version: 0.2\nTerminal: https://x/v1:8443/v1\nKYA-Issuers: https://i:8443\n";
    const m = parseAgentsTxt(input);
    expect(m.terminal).toBe("https://x/v1:8443/v1");
    expect(m.kyaIssuers).toEqual(["https://i:8443"]);
  });
});

// Phase 8.P2.A — agents.txt v1.0 additions.
describe("parseAgentsTxt — v1.0 additions", () => {
  it("parses all six v1.0 optional fields", () => {
    const input = `Facet-Version: 1.0
Terminal: https://terminal.facet.llc
KYA-Issuers: https://issuer.skyfire.xyz
Webhook-Events: order.settled, order.shipped, license.purchased
Response-Signing: ed25519
Response-Keys-URL: https://terminal.facet.llc/.well-known/facet-keys.json
Commerce-Rails: stripe/destination-charge, coin/usdc-base
Content-Licensing: true
Sdk-Version: ^0.2.0
`;
    const m = parseAgentsTxt(input);
    expect(m.facetVersion).toBe("1.0");
    expect(m.webhookEvents).toEqual(["order.settled", "order.shipped", "license.purchased"]);
    expect(m.responseSigning).toBe("ed25519");
    expect(m.responseKeysUrl).toBe("https://terminal.facet.llc/.well-known/facet-keys.json");
    expect(m.commerceRails).toEqual(["stripe/destination-charge", "coin/usdc-base"]);
    expect(m.contentLicensing).toBe(true);
    expect(m.sdkVersion).toBe("^0.2.0");
    // None of the new fields should leak into unknownFields.
    expect(Object.keys(m.unknownFields)).toEqual([]);
  });

  it("omits v1.0 fields entirely when absent (v0.2 docs stay well-formed)", () => {
    const input = `Facet-Version: 0.2
Terminal: https://facet.example.com/v1
KYA-Issuers: https://issuer.skyfire.xyz
`;
    const m = parseAgentsTxt(input);
    expect(m.webhookEvents).toBeUndefined();
    expect(m.responseSigning).toBeUndefined();
    expect(m.responseKeysUrl).toBeUndefined();
    expect(m.commerceRails).toBeUndefined();
    expect(m.contentLicensing).toBeUndefined();
    expect(m.sdkVersion).toBeUndefined();
  });

  it("rejects an unknown Response-Signing value in strict mode", () => {
    const input = `Facet-Version: 1.0
Terminal: https://x/v1
KYA-Issuers: https://i
Response-Signing: rsa-pss-sha512
`;
    expect(() => parseAgentsTxt(input)).toThrow(AgentsTxtError);
    // Lenient mode preserves the field as unknown and continues.
    const lenient = parseAgentsTxt(input, { strict: false });
    expect(lenient.responseSigning).toBeUndefined();
  });

  it("rejects a non-boolean Content-Licensing value in strict mode", () => {
    const input = `Facet-Version: 1.0
Terminal: https://x/v1
KYA-Issuers: https://i
Content-Licensing: maybe
`;
    expect(() => parseAgentsTxt(input)).toThrow(AgentsTxtError);
  });

  it("accepts Response-Signing: none as absence (no error, undefined value)", () => {
    const input = `Facet-Version: 1.0
Terminal: https://x/v1
KYA-Issuers: https://i
Response-Signing: none
`;
    const m = parseAgentsTxt(input);
    expect(m.responseSigning).toBeUndefined();
  });

  it("Webhook-Events with empty entries are dropped; surrounding whitespace trimmed", () => {
    const input = `Facet-Version: 1.0
Terminal: https://x/v1
KYA-Issuers: https://i
Webhook-Events:  order.settled ,  , price.changed,
`;
    const m = parseAgentsTxt(input);
    expect(m.webhookEvents).toEqual(["order.settled", "price.changed"]);
  });
});

// Phase 4 — agents.txt v1.1 additions (Capabilities, Regulated-Gates,
// [business_index] section). Spec: specs/agents.txt-v1.1.md.
describe("parseAgentsTxt — v1.1 additions", () => {
  it("parses a full v1.1 happy-path document", () => {
    // Adapted from spec §7.1 (multi-archetype F&B co-manufacturer).
    const input = `Facet-Version: 1.1
Terminal: https://api.facet.acme-foods.example.com
KYA-Issuers: https://issuer.skyfire.xyz
Contact: agents@acme-foods.example.com
Capabilities: catalog, quote-rfq, paywalled-content, credentialed
Regulated-Gates: license:dea, kyc:basic

[business_index]
ubi_id: ubi:us:il:chicago:60607:acme-foods
nap_name: Acme Foods Co-Manufacturing
nap_address: 1234 W Randolph St, Chicago, IL 60607
naics: 311999
status: open_now
`;
    const m = parseAgentsTxt(input);
    expect(m.facetVersion).toBe("1.1");
    expect(m.terminal).toBe("https://api.facet.acme-foods.example.com");
    expect(m.capabilities).toEqual(["catalog", "quote-rfq", "paywalled-content", "credentialed"]);
    expect(m.regulatedGates).toEqual(["license:dea", "kyc:basic"]);
    expect(m.sections.business_index).toEqual({
      ubi_id: "ubi:us:il:chicago:60607:acme-foods",
      nap_name: "Acme Foods Co-Manufacturing",
      nap_address: "1234 W Randolph St, Chicago, IL 60607",
      naics: "311999",
      status: "open_now",
    });
    // Neither v1.1 field leaks into unknownFields.
    expect(m.unknownFields["capabilities"]).toBeUndefined();
    expect(m.unknownFields["regulated-gates"]).toBeUndefined();
  });

  it("rejects a v1.1 document missing Terminal", () => {
    const input = `Facet-Version: 1.1
KYA-Issuers: https://issuer.skyfire.xyz
Capabilities: catalog
`;
    expect(() => parseAgentsTxt(input)).toThrow(/terminal/);
  });

  it("preserves unknown Capabilities values verbatim (spec §8 forward-compat)", () => {
    const input = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i
Capabilities: catalog, loyalty-program, future-primitive-x
`;
    const m = parseAgentsTxt(input);
    expect(m.capabilities).toEqual(["catalog", "loyalty-program", "future-primitive-x"]);
  });

  it("rejects malformed Regulated-Gates entries (missing colon) in strict mode", () => {
    const input = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i
Regulated-Gates: age21, license:dea
`;
    expect(() => parseAgentsTxt(input)).toThrow(/Regulated-Gates/);
  });

  it("lenient mode preserves malformed Regulated-Gates entries verbatim", () => {
    const input = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i
Regulated-Gates: age21, license:dea
`;
    const m = parseAgentsTxt(input, { strict: false });
    expect(m.regulatedGates).toEqual(["age21", "license:dea"]);
  });

  it("parses a mixed v1.0 + v1.1 document — both surfaces type cleanly", () => {
    const input = `Facet-Version: 1.1
Terminal: https://api.facet.llc
KYA-Issuers: https://issuer.skyfire.xyz
Webhook-Events: order.settled, booking.confirmed, gate.failed
Response-Signing: ed25519
Commerce-Rails: stripe/destination-charge, coin/usdc-base
Content-Licensing: true
Sdk-Version: ^0.3.0
Capabilities: catalog, booking, paywalled-content, credentialed
Regulated-Gates: age:21, jurisdiction:US-CA
`;
    const m = parseAgentsTxt(input);
    // v1.0 surface unchanged.
    expect(m.webhookEvents).toEqual(["order.settled", "booking.confirmed", "gate.failed"]);
    expect(m.responseSigning).toBe("ed25519");
    expect(m.commerceRails).toEqual(["stripe/destination-charge", "coin/usdc-base"]);
    expect(m.contentLicensing).toBe(true);
    expect(m.sdkVersion).toBe("^0.3.0");
    // v1.1 surface present.
    expect(m.capabilities).toEqual(["catalog", "booking", "paywalled-content", "credentialed"]);
    expect(m.regulatedGates).toEqual(["age:21", "jurisdiction:US-CA"]);
  });

  it("v1.1 fields are undefined when absent on v0.2 + v1.0 documents", () => {
    const v0_2 = `Facet-Version: 0.2
Terminal: https://x/v1
KYA-Issuers: https://i
`;
    const v1_0 = `Facet-Version: 1.0
Terminal: https://x/v1
KYA-Issuers: https://i
Webhook-Events: order.settled
`;
    expect(parseAgentsTxt(v0_2).capabilities).toBeUndefined();
    expect(parseAgentsTxt(v0_2).regulatedGates).toBeUndefined();
    expect(parseAgentsTxt(v1_0).capabilities).toBeUndefined();
    expect(parseAgentsTxt(v1_0).regulatedGates).toBeUndefined();
  });

  it("untyped v1.1 top-level keys round-trip through unknownFields (spec §2)", () => {
    // Booking-Strategy + Hold-Duration-Seconds are v1.1 keys not yet
    // typed on AgentsTxt. They must survive parse → re-emit so a v1.1
    // SDK chip can pick them up later without losing data today.
    const input = `Facet-Version: 1.1
Terminal: https://api.bobs-plumbing.example.com
KYA-Issuers: https://issuer.skyfire.xyz
Capabilities: view-handoff, booking
Booking-Strategy: square_appt
Hold-Duration-Seconds: 600
`;
    const m = parseAgentsTxt(input);
    expect(m.capabilities).toEqual(["view-handoff", "booking"]);
    expect(m.unknownFields["booking-strategy"]).toBe("square_appt");
    expect(m.unknownFields["hold-duration-seconds"]).toBe("600");
  });

  it("[business_index] license: appears once via plain key-overwrite (multi-license future-work)", () => {
    // Spec §6.1 says `license` may repeat as multiple independent
    // records. The current key-store flattens duplicates; capture
    // today's behavior so the SDK chip knows when to add list-merge
    // logic. This test asserts the second value wins — when the SDK
    // chip needs multi-license, it'll update the parser AND replace
    // this expectation in the same diff.
    const input = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i

[business_index]
license: state=IL; type=food_processor; number=FP-1
license: federal=DEA; type=registrant; number=BX-1
`;
    const m = parseAgentsTxt(input);
    expect(m.sections.business_index?.license).toBe("federal=DEA; type=registrant; number=BX-1");
  });
});

// Phase 5 of openapi-as-contract — agents.txt v1.2 (additive `OpenAPI:` field).
// Spec: specs/agents.txt-v1.1.md §10.1.
describe("parseAgentsTxt — v1.2 additions", () => {
  it("parses the OpenAPI field on a v1.2 document", () => {
    const input = `Facet-Version: 1.2
Terminal: https://terminal.facet.llc
KYA-Issuers: https://issuer.skyfire.xyz
OpenAPI: https://terminal.facet.llc/v1/openapi.json
`;
    const m = parseAgentsTxt(input);
    expect(m.facetVersion).toBe("1.2");
    expect(m.openApiUrl).toBe("https://terminal.facet.llc/v1/openapi.json");
    // Must NOT leak into unknownFields.
    expect(m.unknownFields["openapi"]).toBeUndefined();
  });

  it("OpenAPI is optional — absence leaves openApiUrl undefined", () => {
    const v0_2 = `Facet-Version: 0.2
Terminal: https://x/v1
KYA-Issuers: https://i
`;
    const v1_1 = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i
Capabilities: catalog
`;
    expect(parseAgentsTxt(v0_2).openApiUrl).toBeUndefined();
    expect(parseAgentsTxt(v1_1).openApiUrl).toBeUndefined();
  });

  it("rejects an empty OpenAPI value in strict mode", () => {
    const input = `Facet-Version: 1.2
Terminal: https://x/v1
KYA-Issuers: https://i
OpenAPI:
`;
    expect(() => parseAgentsTxt(input)).toThrow(/OpenAPI/);
    // Lenient mode swallows the error and leaves openApiUrl undefined.
    const lenient = parseAgentsTxt(input, { strict: false });
    expect(lenient.openApiUrl).toBeUndefined();
  });

  it("trims surrounding whitespace on the OpenAPI value", () => {
    const input = `Facet-Version: 1.2
Terminal: https://x/v1
KYA-Issuers: https://i
OpenAPI:    https://terminal.example.com/v1/openapi.json
`;
    const m = parseAgentsTxt(input);
    expect(m.openApiUrl).toBe("https://terminal.example.com/v1/openapi.json");
  });

  it("a v1.1 document with an OpenAPI line round-trips the field via unknownFields-or-typed (back-compat)", () => {
    // A v1.2 manifest declared as Facet-Version: 1.1 by an operator
    // who forgot the bump still works — the parser is version-blind on
    // optional fields, so the typed surface still picks the field up.
    // This matches the v1.0→v1.1 back-compat clause from §10.
    const input = `Facet-Version: 1.1
Terminal: https://x/v1
KYA-Issuers: https://i
Capabilities: catalog
OpenAPI: https://x/v1/openapi.json
`;
    const m = parseAgentsTxt(input);
    expect(m.openApiUrl).toBe("https://x/v1/openapi.json");
  });

  it("co-exists with v1.0 + v1.1 fields without leakage", () => {
    const input = `Facet-Version: 1.2
Terminal: https://api.facet.llc
KYA-Issuers: https://issuer.skyfire.xyz
Webhook-Events: order.settled, license.purchased
Response-Signing: ed25519
Commerce-Rails: stripe/destination-charge
Content-Licensing: true
Sdk-Version: ^0.4.0
Capabilities: catalog, paywalled-content
Regulated-Gates: age:21
OpenAPI: https://api.facet.llc/v1/openapi.json
`;
    const m = parseAgentsTxt(input);
    expect(m.webhookEvents).toEqual(["order.settled", "license.purchased"]);
    expect(m.capabilities).toEqual(["catalog", "paywalled-content"]);
    expect(m.regulatedGates).toEqual(["age:21"]);
    expect(m.openApiUrl).toBe("https://api.facet.llc/v1/openapi.json");
    expect(Object.keys(m.unknownFields)).toEqual([]);
  });
});
