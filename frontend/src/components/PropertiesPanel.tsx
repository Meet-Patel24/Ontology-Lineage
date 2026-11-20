import { Copy, X } from "lucide-react";
import type { ViewEdge, ViewNode } from "../api/types";
import { labelColor, transformationColor } from "../lib/colors";
import { copyText } from "../lib/format";
import { toast } from "../store/toasts";

type Selected = { kind: "node"; node: ViewNode } | { kind: "edge"; edge: ViewEdge };

async function copy(text: string, what = "Value") {
  if (await copyText(text)) toast.success(`${what} copied`);
}

function CopyBtn({ text, what }: { text: string; what?: string }) {
  return (
    <button
      title="Copy"
      onClick={() => void copy(text, what)}
      className="shrink-0 rounded p-0.5 text-ink-500 opacity-0 transition hover:text-ink-100 group-hover:opacity-100"
    >
      <Copy size={12} />
    </button>
  );
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

const CODE_KEYS = new Set(["expression", "query", "pre_copy_script"]);

export function PropertyList({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <div className="text-xs text-ink-500">No properties</div>;
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => {
        const text = fmt(v);
        const code = CODE_KEYS.has(k) || typeof v === "object";
        return (
          <div key={k} className="group">
            <dt className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-400">
              <span>{k}</span>
              <CopyBtn text={text} what={k} />
            </dt>
            <dd
              className={`break-words text-xs ${code && v !== null ? "mt-0.5 whitespace-pre-wrap rounded bg-ink-950 p-1.5 font-mono text-[11px] text-emerald-700" : "text-ink-100"}`}
            >
              {v === null ? <span className="text-ink-500">null</span> : text}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function PropertiesPanel({
  selected,
  onClose,
  nodeById,
}: {
  selected: Selected;
  onClose: () => void;
  nodeById: Map<string, ViewNode>;
}) {
  const isNode = selected.kind === "node";
  const props = isNode ? selected.node.properties : selected.edge.properties;
  const ident = isNode ? selected.node.id : selected.edge.id;
  const json = JSON.stringify(isNode ? selected.node : selected.edge, null, 2);

  return (
    <aside className="absolute bottom-0 right-0 top-0 z-20 flex w-80 flex-col border-l border-ink-700 bg-ink-900/[0.97] shadow-2xl">
      <header className="flex items-start justify-between gap-2 border-b border-ink-700 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">
            {isNode ? "Node properties" : "Relationship properties"}
          </div>
          {isNode ? (
            <>
              <div className="truncate text-sm font-semibold" title={selected.node.caption}>
                {selected.node.caption}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {selected.node.labels.map((l) => (
                  <span
                    key={l}
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#111827]"
                    style={{ background: labelColor(l) }}
                  >
                    {l}
                  </span>
                ))}
                {selected.node.pii && (
                  <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-700">PII</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold"
                  style={{
                    background: transformationColor(selected.edge.properties.transformation) + "33",
                    color: "#111827",
                  }}
                >
                  :{selected.edge.type}
                </span>
                {selected.edge.reversed && (
                  <span className="text-[10px] text-ink-400" title="Stored as activity → table">
                    drawn reversed
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-ink-300">
                {nodeById.get(selected.edge.source)?.caption ?? selected.edge.source} →{" "}
                {nodeById.get(selected.edge.target)?.caption ?? selected.edge.target}
              </div>
            </>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" title="Close">
          <X size={15} />
        </button>
      </header>
      <div className="flex-1 overflow-auto px-3 py-2">
        <div className="group mb-3">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-400">
            <span>{isNode ? "identity" : "element id"}</span>
            <CopyBtn text={ident} what="Id" />
          </div>
          <div className="break-all font-mono text-[11px] text-ink-200">{ident}</div>
        </div>
        <PropertyList props={props} />
      </div>
      <footer className="border-t border-ink-700 px-3 py-2">
        <button
          onClick={() => void copy(json, "JSON")}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink-300 hover:bg-ink-700 hover:text-ink-100"
        >
          <Copy size={12} /> Copy as JSON
        </button>
      </footer>
    </aside>
  );
}
