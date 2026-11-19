import type { ENode, ERel } from "./api";

const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const cell = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function nodesCsv(nodes: ENode[]): string {
  const keys = [...new Set(nodes.flatMap((n) => Object.keys(n.properties)))].sort();
  const lines = [["elementId", "labels", ...keys].map(esc).join(",")];
  for (const n of nodes) lines.push([n.elementId, n.labels.join(";"), ...keys.map((k) => cell(n.properties[k]))].map(esc).join(","));
  return lines.join("\r\n");
}

export function relsCsv(rels: ERel[]): string {
  const keys = [...new Set(rels.flatMap((r) => Object.keys(r.properties)))].sort();
  const lines = [["elementId", "type", "start", "end", ...keys].map(esc).join(",")];
  for (const r of rels) lines.push([r.elementId, r.type, r.start, r.end, ...keys.map((k) => cell(r.properties[k]))].map(esc).join(","));
  return lines.join("\r\n");
}

const lit = (s: string) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

/** Cypher that brings back exactly the nodes and relationships of the scene. */
export function sceneCypher(nodes: ENode[], rels: ERel[]): string {
  const nodeIds = nodes.map((n) => lit(n.elementId)).join(", ");
  const relIds = rels.map((r) => lit(r.elementId)).join(", ");
  return [
    "// Reproduces the current Bloom scene (element ids are stable within this database)",
    `MATCH (n) WHERE elementId(n) IN [${nodeIds}]`,
    `OPTIONAL MATCH (n)-[r]->(m) WHERE elementId(r) IN [${relIds}]`,
    "RETURN n, r, m",
  ].join("\n");
}
