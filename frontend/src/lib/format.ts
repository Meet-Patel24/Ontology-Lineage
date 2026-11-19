import type { Props } from "../api/types";
import { captionOf, isNeoNode, isNeoPath, isNeoRel } from "./graphConvert";
import { primaryLabel } from "./colors";

/** Single-line text for a value (used for CSV, sorting and copy). */
export function valueToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isNeoNode(v)) return `(:${v.labels.join(":")} ${JSON.stringify(v.properties)})`;
  if (isNeoRel(v)) return `[:${v.type} ${JSON.stringify(v.properties)}]`;
  if (isNeoPath(v)) {
    let s = nodeShort(v.start.properties, v.start.labels);
    for (const seg of v.segments) {
      const fwd = seg.relationship.startNodeElementId === seg.start.elementId;
      s += fwd ? `-[:${seg.relationship.type}]->` : `<-[:${seg.relationship.type}]-`;
      s += nodeShort(seg.end.properties, seg.end.labels);
    }
    return s;
  }
  return JSON.stringify(v);
}

export function nodeShort(props: Props, labels: string[]): string {
  const l = primaryLabel(labels);
  return `(:${l} ${captionOf(props, "")})`;
}

export function toCsv(keys: string[], rows: Record<string, unknown>[]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [keys.map(esc).join(",")];
  for (const r of rows) lines.push(keys.map((k) => esc(valueToText(r[k]))).join(","));
  return lines.join("\r\n");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = "text/plain") {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + name.replace(/`/g, "``") + "`";
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
