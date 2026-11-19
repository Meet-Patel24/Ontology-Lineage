import type { ENode, ERel } from "./api";
import { type Perspective, styleLabel } from "./perspective";
import { type FilterState, propPasses } from "./sceneStore";

export type VisState = "show" | "grey" | "gone";

export interface Visibility {
  nodes: Map<string, VisState>;
  rels: Map<string, VisState>;
  styleLabels: Map<string, string>;
  shownNodes: number;
}

function nodePassesFilters(n: ENode, f: FilterState): boolean {
  for (const c of f.conditions) {
    if (c.kind === "label" && c.value && !n.labels.includes(c.value)) return false;
    if (c.kind === "prop" && (c.target ?? "node") === "node" && c.property) {
      if (c.value && c.value !== "*" && !n.labels.includes(c.value)) continue; // condition scoped to another label
      if (!propPasses(c, n.properties)) return false;
    }
  }
  return true;
}

function relPassesFilters(r: ERel, f: FilterState): boolean {
  for (const c of f.conditions) {
    if (c.kind === "rel" && c.value && r.type !== c.value) return false;
    if (c.kind === "prop" && c.target === "rel" && c.property) {
      if (c.value && c.value !== "*" && r.type !== c.value) continue;
      if (!propPasses(c, r.properties)) return false;
    }
  }
  return true;
}

export function computeVisibility(
  nodes: Record<string, ENode>,
  rels: Record<string, ERel>,
  hidden: string[],
  perspective: Perspective | null,
  filters: FilterState,
  legendHidden: string[],
  counts: Record<string, number>,
): Visibility {
  const hiddenSet = new Set(hidden);
  const legend = new Set(legendHidden);
  const filtering = filters.enabled && filters.conditions.length > 0;
  const filteredState: VisState = filters.mode === "hide" ? "gone" : "grey";
  const nodeState = new Map<string, VisState>();
  const styleLabels = new Map<string, string>();
  let shown = 0;
  for (const n of Object.values(nodes)) {
    const lbl = styleLabel(n, counts);
    styleLabels.set(n.elementId, lbl);
    let st: VisState = "show";
    if (hiddenSet.has(n.elementId) || legend.has(`n:${lbl}`) || perspective?.labels[lbl]?.hidden) st = "gone";
    else if (filtering && !nodePassesFilters(n, filters)) st = filteredState;
    nodeState.set(n.elementId, st);
    if (st !== "gone") shown++;
  }
  const relState = new Map<string, VisState>();
  for (const r of Object.values(rels)) {
    const s = nodeState.get(r.start);
    const e = nodeState.get(r.end);
    let st: VisState = "show";
    if (s === "gone" || e === "gone" || legend.has(`r:${r.type}`) || perspective?.rels[r.type]?.hidden) st = "gone";
    else if (s === "grey" || e === "grey") st = "grey";
    else if (filtering && !relPassesFilters(r, filters)) st = filteredState;
    relState.set(r.elementId, st);
  }
  return { nodes: nodeState, rels: relState, styleLabels, shownNodes: shown };
}
