// Reference parser for the `agents.txt` v0.2 + v1.0 + v1.1 + v1.2 discovery
// manifest. Spec: the agents.txt spec (facet-llc/spec) (also covers v0.2 + v1.0 + v1.2
// back-compat — v1.2 is a single-field additive bump, see §11 of the spec).
// Parser accepts all four versions; each spec rev is purely additive —
// a v0.2 / v1.0 / v1.1 document remains fully valid under v1.2 parsing.

const KNOWN_TOP_LEVEL = new Set<string>([
  "facet-version",
  "terminal",
  "kya-issuers",
  "pricing-hint",
  "rate-limit",
  "alt-identity",
  "reputation-minimum",
  "contact",
  // v1.0 additions — all optional.
  "webhook-events",
  "response-signing",
  "response-keys-url",
  "commerce-rails",
  "content-licensing",
  "sdk-version",
  // v1.1 additions surfaced on the typed interface.
  "capabilities",
  "regulated-gates",
  // v1.2 addition. Points at the Terminal's canonical OpenAPI 3.1 spec
  // served at GET /v1/openapi.json so SDK generators can materialize a
  // client without an out-of-band lookup.
  "openapi",
  // Remaining v1.1 top-level keys (per spec §5) are intentionally NOT
  // added here. They flow through `unknownFields` so the round-trip
  // contract from spec §2 ("Unknown sections + keys MUST be preserved")
  // continues to hold until a future SDK revision types them. Adding
  // them to KNOWN_TOP_LEVEL without a typed surface would silently
  // drop their values.
]);

const REQUIRED = ["facet-version", "terminal", "kya-issuers"] as const;

export class AgentsTxtError extends Error {
  override readonly name = "AgentsTxtError";
}

export interface AgentsTxt {
  readonly facetVersion: string;
  readonly terminal: string;
  readonly kyaIssuers: readonly string[];
  readonly pricingHint?: string;
  readonly rateLimit?: string;
  readonly altIdentity?: "DID";
  readonly reputationMinimum?: number;
  readonly contact?: string;
  // v1.0 additions — all optional, absent on v0.2 documents.
  /** Comma-separated webhook event kinds this Terminal accepts subscriptions for. */
  readonly webhookEvents?: readonly string[];
  /** `ed25519` when the Terminal signs responses. */
  readonly responseSigning?: "ed25519";
  /** Absolute URL of the published response-signing key bundle. */
  readonly responseKeysUrl?: string;
  /** Comma-separated commerce settlement rails advertised. */
  readonly commerceRails?: readonly string[];
  /** `true` when the Terminal exposes content-licensing tools with ≥1 active offer. */
  readonly contentLicensing?: boolean;
  /** Recommended @facet-llc/client semver range against this Terminal build. */
  readonly sdkVersion?: string;
  // v1.1 additions — all optional, absent on v0.2 + v1.0 documents.
  /**
   * Comma-separated list of active business-archetype primitives.
   * Recognized values per spec §5: `catalog`, `paywalled-content`,
   * `subscription`, `booking`, `date-bound-inventory`, `auction`,
   * `quote-rfq`, `credentialed`, `view-handoff`. Unknown future values
   * MUST be preserved verbatim (spec §8) so agents tolerant of newer
   * primitives keep working against older parsers.
   */
  readonly capabilities?: readonly string[];
  /**
   * Comma-separated list of `<kind>:<value>` regulatory gates wrapping
   * the site's primitives (e.g. `age:21`, `jurisdiction:US-CA`,
   * `license:dea`). Multiple gates are AND-combined. In strict mode
   * the parser rejects entries missing a `:` separator; lenient mode
   * preserves them verbatim.
   */
  readonly regulatedGates?: readonly string[];
  // v1.2 additions.
  /**
   * Absolute URL of the Terminal's canonical OpenAPI 3.1 spec
   * (typically `<Terminal>/v1/openapi.json`). SDK generators read this
   * to materialize a typed client against the per-merchant resolved
   * contract without an out-of-band lookup. Absent on v0.2 / v1.0 /
   * v1.1 documents.
   */
  readonly openApiUrl?: string;
  /** Top-level keys present in the source but not defined by v0.2 / v1.0 / v1.1 / v1.2. Preserved for round-tripping. */
  readonly unknownFields: Readonly<Record<string, string>>;
  /** [section] blocks. Section and key names are lower-cased. v1.1 sections (e.g. `business_index`, `booking`, `auction`, `rfq`, `regulated`) flow through here. */
  readonly sections: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ParseOptions {
  /** When true (default), missing required fields and malformed lines throw. */
  readonly strict?: boolean;
}

export function parseAgentsTxt(input: string, options: ParseOptions = {}): AgentsTxt {
  const strict = options.strict ?? true;

  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const topLevel: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> = topLevel;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim().toLowerCase();
      if (name === "") {
        if (strict) throw new AgentsTxtError(`Empty section header: '${rawLine}'`);
        continue;
      }
      const existing = sections[name];
      if (existing !== undefined) {
        current = existing;
      } else {
        const fresh: Record<string, string> = {};
        sections[name] = fresh;
        current = fresh;
      }
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      if (strict) throw new AgentsTxtError(`Malformed line (no ':'): '${rawLine}'`);
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "") {
      if (strict) throw new AgentsTxtError(`Empty key in line: '${rawLine}'`);
      continue;
    }
    current[key] = value;
  }

  if (strict) {
    for (const field of REQUIRED) {
      if (topLevel[field] === undefined) {
        throw new AgentsTxtError(`Missing required field: ${field}`);
      }
    }
  }

  const kyaIssuers = (topLevel["kya-issuers"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (strict && kyaIssuers.length === 0) {
    throw new AgentsTxtError("KYA-Issuers must list at least one issuer URL");
  }

  const unknownFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(topLevel)) {
    if (!KNOWN_TOP_LEVEL.has(k)) unknownFields[k] = v;
  }

  let altIdentity: "DID" | undefined;
  const altRaw = topLevel["alt-identity"];
  if (altRaw !== undefined) {
    if (altRaw === "DID") altIdentity = "DID";
    else if (strict) throw new AgentsTxtError(`Unknown Alt-Identity value: '${altRaw}'`);
  }

  let reputationMinimum: number | undefined;
  const repRaw = topLevel["reputation-minimum"];
  if (repRaw !== undefined) {
    const n = Number.parseInt(repRaw, 10);
    if (Number.isNaN(n) || n < 0 || n > 100) {
      if (strict) throw new AgentsTxtError(`Invalid Reputation-Minimum: '${repRaw}'`);
    } else {
      reputationMinimum = n;
    }
  }

  // v1.0 field parsing — all optional. Reuse the URL-list splitter
  // logic for Webhook-Events + Commerce-Rails so empty entries are
  // rejected uniformly.
  const splitList = (raw: string | undefined): readonly string[] => {
    if (raw === undefined) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const webhookEventsList = splitList(topLevel["webhook-events"]);
  const webhookEvents = topLevel["webhook-events"] !== undefined ? webhookEventsList : undefined;
  const commerceRailsList = splitList(topLevel["commerce-rails"]);
  const commerceRails = topLevel["commerce-rails"] !== undefined ? commerceRailsList : undefined;

  let responseSigning: "ed25519" | undefined;
  const signRaw = topLevel["response-signing"];
  if (signRaw !== undefined) {
    if (signRaw === "ed25519") responseSigning = "ed25519";
    else if (signRaw === "none") responseSigning = undefined;
    else if (strict) {
      throw new AgentsTxtError(`Unknown Response-Signing value: '${signRaw}'`);
    }
  }

  let contentLicensing: boolean | undefined;
  const clRaw = topLevel["content-licensing"];
  if (clRaw !== undefined) {
    if (clRaw === "true") contentLicensing = true;
    else if (clRaw === "false") contentLicensing = false;
    else if (strict) {
      throw new AgentsTxtError(
        `Invalid Content-Licensing value: '${clRaw}' (expected 'true' or 'false')`,
      );
    }
  }

  // v1.1 field parsing — both optional.
  // `Capabilities` is opaque-list per spec §8: unknown future values
  // (e.g. `loyalty-program`) MUST be preserved verbatim. The typed
  // catalog of recognized values lives in the SDK + docs, not here.
  const capabilitiesList = splitList(topLevel["capabilities"]);
  const capabilities = topLevel["capabilities"] !== undefined ? capabilitiesList : undefined;

  // `Regulated-Gates` is a list of `<kind>:<value>` pairs per spec §5.
  // Strict mode rejects entries without a `:`; lenient mode preserves
  // them so downstream tooling can flag them without aborting.
  const regulatedGatesList = splitList(topLevel["regulated-gates"]);
  if (strict && topLevel["regulated-gates"] !== undefined) {
    for (const gate of regulatedGatesList) {
      if (!gate.includes(":")) {
        throw new AgentsTxtError(
          `Malformed Regulated-Gates entry: '${gate}' (expected '<kind>:<value>')`,
        );
      }
    }
  }
  const regulatedGates = topLevel["regulated-gates"] !== undefined ? regulatedGatesList : undefined;

  // v1.2 — OpenAPI URL. Optional, validated only as a non-empty string
  // (URL validation lives in @facet-llc/client, not the parser, so a
  // future scheme — e.g. ipfs:// — doesn't require a parser update).
  const openApiRaw = topLevel["openapi"];
  let openApiUrl: string | undefined;
  if (openApiRaw !== undefined) {
    const trimmed = openApiRaw.trim();
    if (trimmed.length === 0) {
      if (strict) throw new AgentsTxtError("OpenAPI field is present but empty");
    } else {
      openApiUrl = trimmed;
    }
  }

  return {
    facetVersion: topLevel["facet-version"] ?? "",
    terminal: topLevel["terminal"] ?? "",
    kyaIssuers,
    ...(topLevel["pricing-hint"] !== undefined && { pricingHint: topLevel["pricing-hint"] }),
    ...(topLevel["rate-limit"] !== undefined && { rateLimit: topLevel["rate-limit"] }),
    ...(altIdentity !== undefined && { altIdentity }),
    ...(reputationMinimum !== undefined && { reputationMinimum }),
    ...(topLevel["contact"] !== undefined && { contact: topLevel["contact"] }),
    ...(webhookEvents !== undefined && { webhookEvents }),
    ...(responseSigning !== undefined && { responseSigning }),
    ...(topLevel["response-keys-url"] !== undefined && {
      responseKeysUrl: topLevel["response-keys-url"],
    }),
    ...(commerceRails !== undefined && { commerceRails }),
    ...(contentLicensing !== undefined && { contentLicensing }),
    ...(topLevel["sdk-version"] !== undefined && { sdkVersion: topLevel["sdk-version"] }),
    ...(capabilities !== undefined && { capabilities }),
    ...(regulatedGates !== undefined && { regulatedGates }),
    ...(openApiUrl !== undefined && { openApiUrl }),
    unknownFields,
    sections,
  };
}
