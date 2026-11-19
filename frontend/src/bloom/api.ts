import { request } from "../api/client";

export interface ENode {
  elementId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface ERel {
  elementId: string;
  type: string;
  start: string;
  end: string;
  properties: Record<string, unknown>;
}

export interface Diagnosis {
  message: string;
  fixes: { title: string; tokens: Token[] }[];
}

export interface GraphResult {
  nodes: ENode[];
  relationships: ERel[];
  truncated: boolean;
  cypher: string;
  /** Why a search returned nothing (only on empty token searches). */
  diagnosis?: Diagnosis;
  /** Overview only: number of nodes in the whole database. */
  total_nodes?: number;
}

export type TokenKind = "label" | "rel" | "property" | "value" | "text" | "phrase";
export type Direction = "out" | "in" | "both";

export interface Token {
  kind: TokenKind;
  value: string;
  direction?: Direction;
  params?: Record<string, unknown>;
  /** UI only: display text (e.g. a phrase with its value filled in). */
  display?: string;
}

export type SuggestionCategory = "node" | "relationship" | "property" | "value" | "phrase" | "text" | "error";

export interface Suggestion {
  category: SuggestionCategory;
  title: string;
  subtitle?: string;
  chip?: string | null;
  count?: number | null;
  tokens: Token[];
  /** For parameterised phrases: text to put in the input so the user can type the value. */
  fill?: string;
}

export interface PropInfo {
  name: string;
  types: string[];
}

export interface ExploreSchema {
  labels: { name: string; count: number }[];
  relationship_types: { name: string; count: number; pairs: { start: string; end: string }[] }[];
  node_properties: Record<string, PropInfo[]>;
  relationship_properties: Record<string, PropInfo[]>;
  fulltext_indexes: { name: string }[];
  discovered_at: number;
}

export interface NodeDetail extends ENode {
  neighbours: { type: string; direction: "in" | "out"; count: number }[];
}

export interface PhraseParam {
  name: string;
  source: string | null;
}

export interface Phrase {
  id: string;
  name: string;
  description: string;
  cypher: string;
  params: PhraseParam[];
  builtin?: boolean;
}

export type PhraseInput = Omit<Phrase, "id" | "builtin">;

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", body: JSON.stringify(body), signal });

export const exploreApi = {
  schema: (refresh = false) => request<ExploreSchema>("/api/explore/schema", { query: { refresh } }),
  suggest: (q: string, tokens: Token[], signal?: AbortSignal) =>
    request<{ suggestions: Suggestion[] }>("/api/explore/suggest", {
      query: { q, tokens: JSON.stringify(tokens.map(({ display: _d, ...t }) => t)) },
      signal,
    }),
  search: (tokens: Token[], limit: number, signal?: AbortSignal) =>
    request<GraphResult>("/api/explore/search", json({ tokens: tokens.map(({ display: _d, ...t }) => t), limit }, signal)),
  overview: (limit: number, signal?: AbortSignal) => request<GraphResult>("/api/explore/overview", json({ limit }, signal)),
  expand: (ids: string[], opts: { relTypes?: string[]; direction?: Direction; limit: number }) =>
    request<GraphResult>("/api/explore/expand", json({ ids, relTypes: opts.relTypes, direction: opts.direction ?? "both", limit: opts.limit })),
  paths: (from: string, to: string, maxHops = 6) =>
    request<GraphResult>("/api/explore/paths", json({ from, to, maxHops })),
  lineage: (id: string, limit: number) => request<GraphResult>("/api/explore/lineage", json({ id, limit })),
  node: (elementId: string) => request<NodeDetail>(`/api/explore/node/${encodeURIComponent(elementId)}`),
  values: (key: string, label: string | null, q: string) =>
    request<{ values: unknown[] }>("/api/explore/values", { query: { key, label: label ?? undefined, q } }),
  phrases: () => request<Phrase[]>("/api/explore/phrases"),
  createPhrase: (p: PhraseInput) => request<Phrase>("/api/explore/phrases", json(p)),
  updatePhrase: (id: string, p: PhraseInput) =>
    request<Phrase>(`/api/explore/phrases/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(p) }),
  deletePhrase: (id: string) => request<void>(`/api/explore/phrases/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runPhrase: (id: string, params: Record<string, unknown>, limit: number, signal?: AbortSignal) =>
    request<GraphResult>(`/api/explore/phrases/${encodeURIComponent(id)}/run`, json({ params, limit }, signal)),
};
