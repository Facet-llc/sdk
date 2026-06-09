// Typed error for an exchange→merchant binding mismatch.
//
// An ExchangeReader that asserts the merchant binding (the host's production
// reader does) THROWS this when the on-chain exchange does NOT belong to this
// merchant — its seller is not our offer signer (the seller assistant), or its
// settlement token is not our asset. This is a PERMANENT, fail-CLOSED condition
// (x402B #115: a voucher committed against a different seller's offer): the
// adapter maps it to a non-retryable UNAUTHORIZED, distinct from a transient
// RPC / not-yet-indexed read error (which fails OPEN so a momentary chain blip
// cannot block a real settlement).
//
// The host reader throws this; the adapter catches it. Detection uses a
// duck-typed guard (`isBindingMismatchError`) rather than `instanceof` alone,
// so it survives the reader and the adapter resolving to different module
// instances (bundler / dual-package hazard).

export type BindingMismatchKind = "seller" | "asset";

export class BosonBindingMismatchError extends Error {
  /** Discriminates which binding failed. */
  readonly kind: BindingMismatchKind;
  /** The merchant value we required (our signer address / asset). */
  readonly expected: string;
  /** The on-chain value we observed. */
  readonly actual: string;
  /** Stable brand for cross-realm detection. */
  readonly isBosonBindingMismatch = true as const;

  constructor(kind: BindingMismatchKind, expected: string, actual: string) {
    super(
      `Boson exchange ${kind} ${actual} does not match merchant ${kind} ${expected} ` +
        `(${kind === "seller" ? "SELLER" : "ASSET"}_MISMATCH) — refusing to advance settlement`,
    );
    this.name = "BosonBindingMismatchError";
    this.kind = kind;
    this.expected = expected;
    this.actual = actual;
  }
}

/** True for a BosonBindingMismatchError, including across module copies. */
export function isBindingMismatchError(e: unknown): e is BosonBindingMismatchError {
  if (e instanceof BosonBindingMismatchError) return true;
  if (typeof e !== "object" || e === null) return false;
  const o = e as { isBosonBindingMismatch?: unknown; kind?: unknown };
  return o.isBosonBindingMismatch === true && (o.kind === "seller" || o.kind === "asset");
}

/** Map a binding-mismatch kind to the adapter's stable native error code. */
export function bindingMismatchNativeCode(kind: BindingMismatchKind): string {
  return kind === "seller" ? "escrow_seller_mismatch" : "escrow_token_mismatch";
}
