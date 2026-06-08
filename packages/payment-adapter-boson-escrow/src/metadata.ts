// Boson offer metadata (BPIP-1 BASE) — real, resolvable, hash-verified.
//
// Each Facet offer carries a BPIP-1 `BASE`-type metadata document built from
// the product the agent is buying. The on-chain `offer.metadataHash` is a real
// keccak-256 commitment to the exact bytes of that document, and
// `offer.metadataUri` is a resolvable URL that returns those bytes — so any
// third party can fetch the URI, hash the response, and confirm it matches the
// on-chain commitment. This satisfies Boson's hash-verification requirement and
// makes every Facet offer visible + inspectable in the Boson dApp / subgraph.
//
// STATELESS BY DESIGN (zero-data-plane). The canonical JSON is content-encoded
// into the URI path segment, so the serve route is a pure decoder — no metadata
// store, no migration, no per-offer persistence. The scheme can be swapped for
// IPFS pinning later by changing only `buildOfferMetadata` (the URI producer);
// nothing downstream assumes HTTP.

import { keccak256, toBytes } from "viem";

/** Boson metadata kind. We emit `BASE` — the generic offer metadata type — which
 *  is the minimal valid shape every Boson tool understands. `PRODUCT_V1` carries
 *  a full product/variant/seller graph that a headless agent-commerce rail does
 *  not model; BASE is the honest, correct choice here. */
export const BOSON_METADATA_TYPE_BASE = "BASE" as const;

/** The JSON-schema the BASE document conforms to (BPIP-1). Surfaced so resolvers
 *  can validate the shape. */
export const BOSON_BASE_SCHEMA_URL =
  "https://raw.githubusercontent.com/bosonprotocol/BPIPs/main/assets/bpip-1/baseSchema.json";

/** One BPIP-1 attribute (OpenSea-compatible trait). */
export interface BosonMetadataAttribute {
  readonly traitType: string;
  readonly value: string;
}

/** A BPIP-1 BASE metadata document (the subset we populate). */
export interface BosonBaseMetadata {
  readonly schemaUrl: string;
  readonly type: typeof BOSON_METADATA_TYPE_BASE;
  readonly name: string;
  readonly description: string;
  readonly externalUrl: string;
  readonly licenseUrl: string;
  readonly image: string;
  readonly attributes: readonly BosonMetadataAttribute[];
  /** Per-offer uniqueness nonce. Each Boson offer is a distinct sale instance,
   *  so its metadata document (and therefore its hash + URI) is unique. This
   *  guarantees an anti-collision property: two concurrent identical quotes
   *  never produce a byte-identical signed offer (which would revert
   *  OfferSoldOut on the single-quantity template). It is NOT an `attributes`
   *  entry, so Boson UIs that render traits do not surface it. Omitted when no
   *  nonce is supplied. */
  readonly offerNonce?: string;
}

/** Product facts the host server threads in via quote `options.product`. Every
 *  field is optional; the builder fills protocol-safe defaults so a catalog-less
 *  quote still produces valid metadata. */
export interface OfferProductInfo {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly category?: string;
  readonly origin?: string;
  readonly htsCode?: string;
  readonly allergens?: readonly string[];
  readonly tags?: readonly string[];
  readonly image?: string;
  readonly externalUrl?: string;
}

export interface BuildOfferMetadataInput {
  readonly product: OfferProductInfo | undefined;
  /** ERC-20 the offer settles in (offer.exchangeToken) — recorded as a trait so
   *  the metadata is self-describing about the rail. */
  readonly exchangeToken: string;
  /** CAIP-2 network the offer lives on (e.g. eip155:84532). */
  readonly network: string;
  /** Public base origin the host server serves the metadata route from
   *  (e.g. https://acme.facet.llc). Trailing slash tolerated. */
  readonly metadataBaseUri: string;
  /** Optional per-offer uniqueness nonce (see `BosonBaseMetadata.offerNonce`).
   *  Supply a fresh value per quote (e.g. crypto.randomUUID()) so concurrent
   *  identical quotes never collide; omit in tests for deterministic output. */
  readonly nonce?: string;
}

export interface BuiltOfferMetadata {
  /** The BPIP-1 BASE document. */
  readonly metadata: BosonBaseMetadata;
  /** Canonical (deterministic, sorted-key) JSON serialization — the exact bytes
   *  the serve route returns and the hash commits to. */
  readonly canonicalJson: string;
  /** keccak-256 over the canonical UTF-8 bytes, 0x-prefixed. Goes on-chain as
   *  `offer.metadataHash`; a resolver recomputes it from the fetched body. */
  readonly metadataHash: `0x${string}`;
  /** Resolvable URI that returns `canonicalJson`. Goes on-chain as
   *  `offer.metadataUri`. */
  readonly metadataUri: string;
}

const MAX_DESCRIPTION_LEN = 600;

/** Build the BPIP-1 BASE metadata, its canonical JSON, the keccak hash, and the
 *  resolvable URI for an offer. Deterministic: identical inputs → identical
 *  hash + URI (no randomness), so the serve route can be a pure decoder. */
export function buildOfferMetadata(input: BuildOfferMetadataInput): BuiltOfferMetadata {
  const p = input.product ?? {};
  const name = nonEmpty(p.name) ?? "Facet agent-commerce order";
  const description =
    truncate(nonEmpty(p.description), MAX_DESCRIPTION_LEN) ??
    `${name} — settled non-custodially via Boson Protocol escrow (x402B) on Facet.`;

  const attributes: BosonMetadataAttribute[] = [
    { traitType: "Settlement", value: "Boson escrow (x402B)" },
  ];
  pushAttr(attributes, "Network", input.network);
  pushAttr(attributes, "Exchange Token", input.exchangeToken);
  pushAttr(attributes, "Product ID", p.id);
  pushAttr(attributes, "Category", p.category);
  pushAttr(attributes, "Country of Origin", p.origin);
  pushAttr(attributes, "HTS Code", p.htsCode);
  if (p.allergens !== undefined && p.allergens.length > 0) {
    pushAttr(attributes, "Allergens", p.allergens.join(", "));
  }
  if (p.tags !== undefined && p.tags.length > 0) {
    pushAttr(attributes, "Tags", p.tags.slice(0, 12).join(", "));
  }

  const metadata: BosonBaseMetadata = {
    schemaUrl: BOSON_BASE_SCHEMA_URL,
    type: BOSON_METADATA_TYPE_BASE,
    name,
    description,
    externalUrl: nonEmpty(p.externalUrl) ?? "",
    licenseUrl: "",
    image: nonEmpty(p.image) ?? "",
    attributes,
    ...(nonEmpty(input.nonce) !== undefined ? { offerNonce: input.nonce } : {}),
  };

  const canonicalJson = canonicalStringify(metadata);
  const metadataHash = keccak256(toBytes(canonicalJson));
  // Query-param form (?d=<base64url>) so the host server route key stays an exact
  // pathname the router can match (the router is exact-match on method+path).
  const metadataUri = `${trimTrailingSlash(input.metadataBaseUri)}${OFFER_METADATA_PATH}?d=${encodeMetadataPath(canonicalJson)}`;

  return { metadata, canonicalJson, metadataHash, metadataUri };
}

/** Pathname the host server mounts the offer-metadata serve route on. Exported so
 *  the route handler and the URI producer share one spelling. */
export const OFFER_METADATA_PATH = "/v1/boson/offer-metadata";

/** Extract the `d` (base64url metadata) param from a metadata URL, or null. */
export function metadataParamFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("d");
  } catch {
    return null;
  }
}

// ─── serve-route codec (shared by the adapter + the host server route) ───────────

/** URL-safe base64 of the canonical JSON — the self-contained path segment the
 *  serve route decodes. base64url so it survives a path segment untouched. */
export function encodeMetadataPath(canonicalJson: string): string {
  return base64UrlEncode(canonicalJson);
}

/** Decode + validate a metadata path segment back into its canonical JSON.
 *  Returns null on any malformed input (the route answers 404/400, never
 *  throws). Re-serializes through `canonicalStringify` so the returned bytes are
 *  exactly what the hash commits to, even if a caller re-encoded with different
 *  key order or whitespace. */
export function decodeMetadataPath(
  segment: string,
): { readonly canonicalJson: string; readonly metadata: BosonBaseMetadata } | null {
  let json: string;
  try {
    json = base64UrlDecode(segment);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isBaseMetadata(parsed)) return null;
  return { canonicalJson: canonicalStringify(parsed), metadata: parsed };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isBaseMetadata(v: unknown): v is BosonBaseMetadata {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.type === BOSON_METADATA_TYPE_BASE && typeof o.name === "string";
}

function nonEmpty(v: string | undefined | null): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function truncate(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}

function pushAttr(
  into: BosonMetadataAttribute[],
  traitType: string,
  value: string | undefined,
): void {
  const v = nonEmpty(value);
  if (v !== undefined) into.push({ traitType, value: v });
}

function trimTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/** Deterministic JSON: object keys sorted recursively, no incidental whitespace.
 *  Two semantically-equal documents always serialize byte-identically, so the
 *  hash is stable and a resolver can recompute it. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// base64url over UTF-8 — available on both runtimes (Deno + Node/vitest).
function base64UrlEncode(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return decodeURIComponent(escape(atob(b64 + pad)));
}
