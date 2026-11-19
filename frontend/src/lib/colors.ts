// Consistent colours for labels and transformations across all graphs.

export const LABEL_COLORS: Record<string, string> = {
  Database: "#f59e0b",
  Schema: "#d97706",
  Table: "#4f9cf9",
  View: "#22d3ee",
  Column: "#94a3b8",
  Lakehouse: "#10b981",
  Warehouse: "#059669",
  Pipeline: "#f472b6",
  Activity: "#fb7185",
  BusinessConcept: "#a78bfa",
  Classification: "#ef4444",
};

const EXTRA = ["#facc15", "#2dd4bf", "#c084fc", "#fb923c", "#84cc16", "#e879f9", "#38bdf8", "#fda4af"];

export function labelColor(label: string): string {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return EXTRA[h % EXTRA.length];
}

export const TRANSFORMATION_COLORS: Record<string, string> = {
  MASKED: "#ef4444",
  AGGREGATED: "#a855f7",
  DERIVED: "#3b82f6",
  DIRECT: "#9ca3af",
  CAST: "#64748b",
};

export const DEFAULT_EDGE_COLOR = "#5b6577";

export function transformationColor(t: unknown): string {
  return (typeof t === "string" && TRANSFORMATION_COLORS[t]) || DEFAULT_EDGE_COLOR;
}

export const PII_RING = "#ef4444";
export const START_RING = "#facc15";

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
];

/** Most specific label of a node (ignoring the generic :Asset label). */
export function primaryLabel(labels: string[]): string {
  const specific = labels.filter((l) => l !== "Asset");
  const list = specific.length ? specific : labels;
  for (const l of LABEL_PRIORITY) if (list.includes(l)) return l;
  return [...list].sort()[0] ?? "Node";
}
