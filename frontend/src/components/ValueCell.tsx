import { useState } from "react";
import type { NeoNode, NeoRelationship } from "../api/types";
import { labelColor, primaryLabel } from "../lib/colors";
import { captionOf, isNeoNode, isNeoPath, isNeoRel } from "../lib/graphConvert";

function NodeChip({ node }: { node: NeoNode }) {
  const [open, setOpen] = useState(false);
  const label = primaryLabel(node.labels);
  return (
    <span className="inline-flex max-w-full flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Show properties"
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-ink-600 bg-ink-850 py-0.5 pl-0.5 pr-2 text-[11px] hover:border-ink-400"
      >
        <span className="rounded-full px-1.5 text-[10px] font-semibold text-ink-950" style={{ background: labelColor(label) }}>
          {label}
        </span>
        <span className="truncate">{captionOf(node.properties, node.elementId)}</span>
      </button>
      {open && <JsonBlock value={node.properties} />}
    </span>
  );
}

function relText(r: NeoRelationship, a?: NeoNode, b?: NeoNode): string {
  const la = a ? primaryLabel(a.labels) : "";
  const lb = b ? primaryLabel(b.labels) : "";
  return `(${la ? ":" + la : ""})-[:${r.type}]->(${lb ? ":" + lb : ""})`;
}

function RelChip({ rel }: { rel: NeoRelationship }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex max-w-full flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        className="max-w-full truncate rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-[11px] hover:border-ink-400"
        title="Show properties"
      >
        {relText(rel)}
      </button>
      {open && <JsonBlock value={rel.properties} />}
    </span>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-1.5 font-mono text-[10px] text-emerald-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-ink-500">null</span>;
  if (typeof value === "boolean")
    return <span className={value ? "text-emerald-400" : "text-rose-400"}>{String(value)}</span>;
  if (typeof value === "number") return <span className="font-mono text-amber-300">{value}</span>;
  if (typeof value === "string") return <span className="whitespace-pre-wrap break-words">{value}</span>;
  if (isNeoNode(value)) return <NodeChip node={value} />;
  if (isNeoRel(value)) return <RelChip rel={value} />;
  if (isNeoPath(value)) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <NodeChip node={value.start} />
        {value.segments.map((s, i) => {
          const fwd = s.relationship.startNodeElementId === s.start.elementId;
          return (
            <span key={i} className="flex items-center gap-1">
              <span className="font-mono text-[10px] text-ink-400">
                {fwd ? `-[:${s.relationship.type}]->` : `<-[:${s.relationship.type}]-`}
              </span>
              <NodeChip node={s.end} />
            </span>
          );
        })}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-500">[]</span>;
    if (value.every((v) => typeof v !== "object" || v === null))
      return <span className="font-mono text-[11px]">[{value.map((v) => JSON.stringify(v)).join(", ")}]</span>;
    return (
      <span className="flex flex-col gap-1">
        {value.map((v, i) => (
          <ValueCell key={i} value={v} />
        ))}
      </span>
    );
  }
  return <JsonBlock value={value} />;
}
