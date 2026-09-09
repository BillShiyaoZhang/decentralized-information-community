/** JSON-only data is portable across browsers, files and server adapters. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface NodeType {
  id: string;
  label: string;
  required?: Array<'body' | 'source'>;
}
export interface RelationType {
  id: string;
  label: string;
  from: string[];
  to: string[];
}
export interface Ontology {
  nodeTypes: NodeType[];
  relationTypes: RelationType[];
}
export interface GraphNode {
  id: string;
  type: string;
  title: string;
  body: string;
  source: string;
  author: string;
  tags: string[];
  /** UTC ISO date, e.g. 2026-09-09T08:00:00.000Z. */
  updatedAt: string;
  [property: string]: JsonValue;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  reason: string;
  [property: string]: JsonValue;
}
export interface Graph<N extends GraphNode = GraphNode, E extends GraphEdge = GraphEdge> {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  revision: number;
  ontology: Ontology;
  nodes: N[];
  edges: E[];
}
export type ChangeOperation<N extends GraphNode = GraphNode, E extends GraphEdge = GraphEdge> =
  | { op: 'putNode'; value: N }
  | { op: 'putEdge'; value: E };
export interface GraphChange<N extends GraphNode = GraphNode, E extends GraphEdge = GraphEdge> {
  schemaVersion: 1;
  id: string;
  graphId: string;
  baseRevision: number;
  operations: ChangeOperation<N, E>[];
}
export interface SearchOptions { query?: string; type?: string; tag?: string; }
export interface GraphStats {
  nodes: number;
  edges: number;
  isolated: number;
  hubs: Array<{ id: string; connections: number }>;
}
export class GraphError extends Error {
  code: string;
  constructor(message: string, code?: string);
}
export function safeUrl(value: unknown): boolean;
/** Returns the original validated object. Does not freeze it. */
export function validateOntology<T extends Ontology>(ontology: T): T;
export function validateOntology(ontology: unknown): Ontology;
export function validateGraph<N extends GraphNode, E extends GraphEdge>(graph: Graph<N, E>): Graph<N, E>;
export function validateGraph(graph: unknown): Graph;
/** Applies a proposal to a clone. The input graph is never mutated. */
export function applyChange<N extends GraphNode, E extends GraphEdge>(graph: Graph<N, E>, change: GraphChange<N, E>): Graph<N, E>;
export function applyChange(graph: Graph, change: unknown): Graph;
export function makeChange<N extends GraphNode, E extends GraphEdge>(graph: Graph<N, E>, operations: ChangeOperation<N, E>[], id?: string): GraphChange<N, E>;
/** Empty operations means there is nothing to submit; applyChange rejects empty proposals. */
export function diffGraphs<N extends GraphNode, E extends GraphEdge>(base: Graph<N, E>, draft: Graph<N, E>, id?: string): GraphChange<N, E>;
/** Results reference the input nodes. Copy before mutating them. */
export function searchGraph<N extends GraphNode>(graph: Graph<N>, options?: SearchOptions): N[];
/** The neighborhood is undirected, while returned edges retain their original directions. */
export function neighborhood<N extends GraphNode, E extends GraphEdge>(graph: Graph<N, E>, nodeId: string, depth?: number): { nodes: N[]; edges: E[] };
export function graphStats(graph: Graph): GraphStats;
