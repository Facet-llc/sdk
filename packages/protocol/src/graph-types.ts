// @facet-llc/protocol — Knowledge-graph (facet × graphify) types.
//
// Wire-contract types for the knowledge-graph (facet × graphify)
// primitive, authored in the protocol package.
//
// Three Terminal routes share these types:
//   POST /v1/graph/match
//   GET  /v1/graph/related
//   GET  /v1/graph/path
//
// The node-type + relation literal unions mirror the graph's runtime
// type sets, kept aligned with the wire contract by a drift check.

// ─────────────────────────────────────────────────────────────────────────────
// Closed enums — must stay in lockstep with the SQL CHECK constraints
// ─────────────────────────────────────────────────────────────────────────────

export type KgNodeType =
  | "ingredient"
  | "regulation"
  | "certification"
  | "formulation"
  | "vendor"
  | "batch"
  | "capability"
  | "constraint"
  | "concept"
  | "module"
  | "agent"
  | "skill"
  | "tool_ref"
  | "business"
  | "jurisdiction"
  | "license_type"
  | "naics_class"
  | "corridor";

export type KgRelation =
  | "supplies"
  | "licensed_by"
  | "located_in"
  | "complies_with"
  | "owns"
  | "competes_with"
  | "same_naics"
  | "same_zip"
  | "same_corridor"
  | "references"
  | "cites"
  | "semantically_similar_to"
  | "derived_from";

// ─────────────────────────────────────────────────────────────────────────────
// Projection types — what the agent sees
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchHit {
  readonly id: string;
  readonly ubi_id: string | null;
  readonly label: string;
  /** Wire-shape note: the literal union `KgNodeType` is the
   *  authoritative catalog, but the underlying Postgres column is
   *  `text` so the handler returns whatever the DB row says. New
   *  node_types reach this field before the union update. */
  readonly node_type: KgNodeType | string;
  readonly similarity: number;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface RelatedNode {
  readonly id: string;
  readonly ubi_id: string | null;
  readonly label: string;
  readonly node_type: KgNodeType | string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface RelatedEdge {
  readonly id: string;
  readonly src_node_id: string;
  readonly dst_node_id: string;
  readonly relation: KgRelation | string;
  readonly weight: number;
  readonly properties: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/graph/match
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphMatchRequest {
  readonly query_text: string;
  readonly node_types?: readonly (KgNodeType | string)[];
  readonly count?: number;
  readonly threshold?: number;
}

export interface GraphMatchResponse {
  readonly hits: readonly MatchHit[];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/graph/related (query-param-driven)
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphRelatedQueryParams {
  readonly ubi_id: string;
  readonly hops?: number;
  readonly max_nodes?: number;
  /** Optional CSV when transmitted on the URL; canonicalized to a
   *  `readonly string[]` by the parser. */
  readonly relations?: readonly (KgRelation | string)[];
}

export interface GraphRelatedResponse {
  readonly seed: { readonly ubi_id: string; readonly node_id: string };
  readonly nodes: readonly RelatedNode[];
  readonly edges: readonly RelatedEdge[];
  readonly node_count: number;
  readonly edge_count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/graph/path
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphPathQueryParams {
  readonly from: string;
  readonly to: string;
  readonly max_hops?: number;
}

export interface GraphPathResponse {
  readonly found: boolean;
  readonly hops: number;
  readonly path: readonly RelatedNode[];
  readonly edges: readonly RelatedEdge[];
}
