// Consistent colours for labels and transformations across all graphs.

export const LABEL_COLORS: Record<string, string> = {
  Database: "#EBAA01",
  Schema: "#F3C64A",
  Table: "#0FBDFF",
  View: "#2FC4C9",
  Column: "#A9B6CB",
  Lakehouse: "#5ECC62",
  Warehouse: "#8EDB91",
  Pipeline: "#AE63E4",
  Activity: "#C99BF0",
  BusinessConcept: "#F4A261",
  Classification: "#EF6B6B",
  PolicyDocument: "#F59FBC",
  PolicyChunk: "#FBCFE0",
};

/** Policy document -> governed asset (dashed). */
export const GOVERNS_COLOR = "#C2255C";

const EXTRA = ["#7FD8E0", "#F7D46B", "#D2A8F2", "#F4A261", "#A3E3A5", "#7FA8FF", "#5CCFFF", "#F7A8B8"];

export function labelColor(label: string): string {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return EXTRA[h % EXTRA.length];
}

export const TRANSFORMATION_COLORS: Record<string, string> = {
  MASKED: "#ef4444",
  AGGREGATED: "#AE63E4",
  DERIVED: "#0099A8",
  DIRECT: "#6B7280",
  CAST: "#475569",
};

export const DEFAULT_EDGE_COLOR = "#94A3B8";

export function transformationColor(t: unknown): string {
  return (typeof t === "string" && TRANSFORMATION_COLORS[t]) || DEFAULT_EDGE_COLOR;
}

export const PII_RING = "#ef4444";
export const START_RING = "#EBAA01";

const LABEL_PRIORITY = [
  "Column",
  "Table",
  "View",
  "Activity",
  "Pipeline",
  "Schema",
  "Database",
  "Lakehouse",
  "Warehouse",
  "BusinessConcept",
  "Classification",
  "PolicyDocument",
  "PolicyChunk",
];

/** Most specific label of a node (ignoring the generic :Asset label). */
export function primaryLabel(labels: string[]): string {
  const specific = labels.filter((l) => l !== "Asset");
  const list = specific.length ? specific : labels;
  for (const l of LABEL_PRIORITY) if (list.includes(l)) return l;
  return [...list].sort()[0] ?? "Node";
}
