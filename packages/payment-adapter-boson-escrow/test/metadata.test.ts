import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";

import {
  buildOfferMetadata,
  canonicalStringify,
  decodeMetadataPath,
  encodeMetadataPath,
  metadataParamFromUrl,
} from "../src/metadata.ts";

const BASE = "https://acme.facet.llc";
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const NETWORK = "eip155:84532";

function build(over: Parameters<typeof buildOfferMetadata>[0] | Record<string, unknown> = {}) {
  return buildOfferMetadata({
    product: undefined,
    exchangeToken: ASSET,
    network: NETWORK,
    metadataBaseUri: BASE,
    ...(over as object),
  });
}

describe("buildOfferMetadata — BPIP-1 BASE offer metadata", () => {
  it("emits a valid BPIP-1 BASE document with a resolvable URI and real keccak hash", () => {
    const { metadata, metadataUri, metadataHash } = build({
      product: {
        id: "p1",
        name: "Acme Serum",
        description: "Brightening serum",
        category: "skincare",
        origin: "US",
        htsCode: "3304.99",
        allergens: ["none"],
        tags: ["vegan"],
      },
    });
    expect(metadata.type).toBe("BASE");
    expect(metadata.name).toBe("Acme Serum");
    expect(metadata.schemaUrl).toMatch(/^https:\/\//);
    // Product facts surface as BPIP-1 attributes.
    const traits = Object.fromEntries(metadata.attributes.map((a) => [a.traitType, a.value]));
    expect(traits["Product ID"]).toBe("p1");
    expect(traits["Country of Origin"]).toBe("US");
    expect(traits["HTS Code"]).toBe("3304.99");
    expect(traits["Exchange Token"]).toBe(ASSET);
    // URI is a resolvable HTTPS route; hash is a real keccak-256.
    expect(metadataUri).toMatch(/^https:\/\/acme\.facet\.llc\/v1\/boson\/offer-metadata\?d=/);
    expect(metadataUri).not.toContain("ipfs://");
    expect(metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("fills protocol-safe defaults for a catalog-less quote (still real, fully populated)", () => {
    const { metadata, metadataHash } = build();
    expect(metadata.name).toBe("Facet agent-commerce order");
    expect(metadata.description.length).toBeGreaterThan(0);
    expect(metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic without a nonce: identical inputs → identical hash + URI", () => {
    const a = build({ product: { name: "X" } });
    const b = build({ product: { name: "X" } });
    expect(a.metadataHash).toBe(b.metadataHash);
    expect(a.metadataUri).toBe(b.metadataUri);
  });

  it("is unique with a nonce: same product, different nonce → different hash (anti-collision)", () => {
    const a = build({ product: { name: "X" }, nonce: "nonce-1" });
    const b = build({ product: { name: "X" }, nonce: "nonce-2" });
    expect(a.metadataHash).not.toBe(b.metadataHash);
    expect(a.metadataUri).not.toBe(b.metadataUri);
    // The nonce rides the document, not the human-facing traits.
    expect(a.metadata.offerNonce).toBe("nonce-1");
    expect(a.metadata.attributes.some((t) => /nonce/i.test(t.traitType))).toBe(false);
  });

  it("the on-chain hash commits to the exact served bytes (resolver round-trip)", () => {
    const { metadataUri, metadataHash, canonicalJson } = build({
      product: { name: "Round Trip", description: "verify me" },
      nonce: "abc",
    });
    // A resolver fetches the URI's `d` param and decodes it.
    const segment = metadataParamFromUrl(metadataUri)!;
    const decoded = decodeMetadataPath(segment);
    expect(decoded).not.toBeNull();
    expect(decoded!.canonicalJson).toBe(canonicalJson);
    // Re-hashing the served bytes reproduces the on-chain metadataHash.
    expect(keccak256(toBytes(decoded!.canonicalJson))).toBe(metadataHash);
  });

  it("encodeMetadataPath/decodeMetadataPath round-trips and rejects garbage", () => {
    const json = canonicalStringify({ type: "BASE", name: "ok", attributes: [] });
    const seg = encodeMetadataPath(json);
    const back = decodeMetadataPath(seg);
    expect(back!.metadata.name).toBe("ok");
    // Not base64 / not JSON / not BASE-typed → null (route answers 404, never throws).
    expect(decodeMetadataPath("!!!not-base64!!!")).toBeNull();
    expect(decodeMetadataPath(encodeMetadataPath("not json"))).toBeNull();
    expect(decodeMetadataPath(encodeMetadataPath(JSON.stringify({ type: "NOPE" })))).toBeNull();
  });
});
