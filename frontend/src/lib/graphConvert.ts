import type { GraphData, NeoGraph, NeoNode, NeoRelationship, Props, ViewEdge, ViewNode } from "../api/types";
import { primaryLabel } from "./colors";

/** Caption shown inside a node: `name`, falling back to `id`, then other common keys. */
export function captionOf(props: Props, fallback: string): string {
  for (const key of ["name", "id", "title", "full_name", "label"]) {
    const v = props[key];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return fallback;
}

export function neoNodeToView(n: NeoNode): ViewNode {
  const label = primaryLabel(n.labels);
  const p = n.properties;
  return {
    id: n.elementId,
    labels: n.labels.filter((l) => l !== "Asset"),
    label,
    caption: captionOf(p, label),
    subtitle: label === "Column" ? (p.table as string | undefined) ?? null : null,
    properties: p,
    pii: p.is_pii === true,
  };
}

export function neoRelToView(r: NeoRelationship): ViewEdge {
  return {
    id: r.elementId,
    source: r.startNodeElementId,
    target: r.endNodeElementId,
    type: r.type,
    label: r.type,
    properties: r.properties,
  };
}

export function neoGraphToView(g: NeoGraph): GraphData {
  return { nodes: g.nodes.map(neoNodeToView), edges: g.relationships.map(neoRelToView) };
}

/** Merge b into a (by id), keeping a's order. */
export function mergeGraphs(a: GraphData, b: GraphData): GraphData {
  const nodeIds = new Set(a.nodes.map((n) => n.id));
  const edgeIds = new Set(a.edges.map((e) => e.id));
  return {
    nodes: [...a.nodes, ...b.nodes.filter((n) => !nodeIds.has(n.id))],
    edges: [...a.edges, ...b.edges.filter((e) => !edgeIds.has(e.id))],
  };
}

export function isNeoNode(v: unknown): v is NeoNode {
  return typeof v === "object" && v !== null && (v as { $type?: string }).$type === "node";
}
export function isNeoRel(v: unknown): v is NeoRelationship {
  return typeof v === "object" && v !== null && (v as { $type?: string }).$type === "relationship";
}
export function isNeoPath(v: unknown): v is import("../api/types").NeoPath {
  return typeof v === "object" && v !== null && (v as { $type?: string }).$type === "path";
}
