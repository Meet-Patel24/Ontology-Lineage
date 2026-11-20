import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { GraphData, ViewNode } from "../../api/types";
import { DataTable } from "../../components/DataTable";
import { GraphView } from "../../components/GraphView";
import { ValueCell } from "../../components/ValueCell";
import { ErrorPanel } from "../../components/ui";
import { mergeGraphs, neoGraphToView } from "../../lib/graphConvert";
import { copyText, downloadText, timestampSlug, toCsv, valueToText } from "../../lib/format";
import { type Frame, useFrames } from "../../store/queries";
import { toast } from "../../store/toasts";

type Tab = "graph" | "table" | "raw";
type Row = Record<string, unknown>;

export function ResultFrame({ frame, onRerun }: { frame: Frame; onRerun: (f: Frame) => void }) {
  const updateFrame = useFrames((s) => s.updateFrame);
  const removeFrame = useFrames((s) => s.removeFrame);
  const [expandedQuery, setExpandedQuery] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const result = frame.result;
  const hasGraph = !!result && result.graph.nodes.length > 0;
  const [tab, setTab] = useState<Tab>("table");
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });

  // Pick the default tab and reset the graph whenever a new result arrives.
  useEffect(() => {
    if (!result) return;
    setTab(result.graph.nodes.length > 0 ? "graph" : "table");
    setGraph(neoGraphToView(result.graph));
  }, [result]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const expand = async (node: ViewNode) => {
    const g = await api.neighbors(node.id);
    const add = neoGraphToView(g);
    setGraph((cur) => mergeGraphs(cur, add));
    const added = add.nodes.filter((n) => !graph.nodes.some((m) => m.id === n.id)).length;
    if (added === 0) toast.info("No new neighbours", node.caption);
  };

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () =>
      (result?.keys ?? []).map((k) => ({
        id: k,
        header: k,
        accessorFn: (r: Row) => r[k],
        cell: (c) => <ValueCell value={c.getValue()} />,
        sortingFn: (a, b, id) => {
          const va = a.getValue(id);
          const vb = b.getValue(id);
          if (typeof va === "number" && typeof vb === "number") return va - vb;
          return valueToText(va).localeCompare(valueToText(vb));
        },
        size: Math.max(140, Math.min(420, 900 / Math.max(1, result?.keys.length ?? 1))),
      })),
    [result],
  );

  const s = result?.summary;
  const statusLine =
    frame.status === "done" && result
      ? `Started streaming ${result.records.length} record${result.records.length === 1 ? "" : "s"} after ${s?.available_after_ms ?? "?"} ms and completed after ${
          (s?.available_after_ms ?? 0) + (s?.consumed_after_ms ?? 0)
        } ms.`
      : null;

  const counters = s ? Object.entries(s.counters ?? {}) : [];

  const body = (
    <>
      {frame.status === "running" && (
        <div className="flex items-center gap-2 px-3 py-6 text-xs text-ink-300">
          <Loader2 size={14} className="animate-spin" /> Running query…
        </div>
      )}
      {frame.status === "error" && frame.error && (
        <div className="p-3">
          <ErrorPanel code={frame.error.code} message={frame.error.message} />
        </div>
      )}
      {frame.info && (
        <div className="p-3 text-xs">
          <div className="font-semibold">{frame.info.title}</div>
          {frame.info.body !== undefined && (
            <pre className="mt-2 overflow-auto rounded bg-ink-950 p-2 font-mono text-[11px] text-emerald-700">
              {JSON.stringify(frame.info.body, null, 2)}
            </pre>
          )}
        </div>
      )}
      {frame.status === "done" && result && (
        <div className="flex min-h-0 flex-1 flex-col">
          {result.truncated && (
            <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800">
              <AlertTriangle size={13} /> Results truncated at {result.records.length} rows (MAX_ROWS). Add a LIMIT or refine
              the query to see everything.
            </div>
          )}
          {s && s.notifications.length > 0 && (
            <div className="border-b border-ink-700 bg-ink-850 px-3 py-1.5 text-[11px] text-amber-800">
              {s.notifications.map((n, i) => (
                <div key={i} title={n.description}>
                  <AlertTriangle size={11} className="mr-1 inline" />
                  {n.title || n.code}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1 border-b border-ink-700 px-2">
            {(["graph", "table", "raw"] as Tab[]).map((t) => (
              <button
                key={t}
                disabled={t === "graph" && !hasGraph}
                onClick={() => setTab(t)}
                className={`border-b-2 px-3 py-1.5 text-xs capitalize transition disabled:cursor-not-allowed disabled:opacity-30 ${
                  tab === t ? "border-accent text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200"
                }`}
              >
                {t}
              </button>
            ))}
            <div className="flex-1" />
            {tab === "table" && (
              <button
                onClick={() => downloadText(toCsv(result.keys, result.records), `result-${timestampSlug()}.csv`, "text/csv")}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700"
              >
                <Download size={12} /> CSV
              </button>
            )}
            {tab === "raw" && (
              <button
                onClick={() =>
                  downloadText(
                    JSON.stringify({ query: frame.query, params: frame.params, ...result }, null, 2),
                    `result-${timestampSlug()}.json`,
                    "application/json",
                  )
                }
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700"
              >
                <Download size={12} /> JSON
              </button>
            )}
          </div>
          <div className={`min-h-0 flex-1 ${fullscreen ? "" : ""} p-2`}>
            {tab === "graph" && hasGraph && (
              <GraphView
                data={graph}
                layout="force"
                onExpand={expand}
                filenameBase="query-graph"
                className={fullscreen ? "h-full" : "h-[460px]"}
              />
            )}
            {tab === "table" &&
              (result.keys.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-ink-400">
                  (no columns returned){counters.length > 0 && ` · ${counters.map(([k, v]) => `${k}: ${v}`).join(", ")}`}
                </div>
              ) : (
                <DataTable
                  data={result.records}
                  columns={columns}
                  maxHeight={fullscreen ? "calc(100vh - 170px)" : "460px"}
                  cellText={(r, id) => valueToText(r[id])}
                  emptyText="(no records)"
                />
              ))}
            {tab === "raw" && (
              <pre
                className="overflow-auto rounded-md border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] text-ink-200"
                style={{ maxHeight: fullscreen ? "calc(100vh - 170px)" : "460px" }}
              >
                {JSON.stringify({ keys: result.keys, records: result.records, summary: result.summary }, null, 2)}
              </pre>
            )}
          </div>
          {statusLine && (
            <div className="border-t border-ink-700 px-3 py-1.5 text-[11px] text-ink-400">
              {statusLine}
              {s?.query_type && <span className="ml-2 text-ink-500">Query type: {s.query_type}</span>}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-ink-900"
          : `overflow-hidden rounded-lg border bg-ink-900 ${frame.pinned ? "border-accent/60" : "border-ink-700"}`
      }
    >
      <header className="flex items-start gap-2 border-b border-ink-700 bg-ink-850 px-3 py-1.5">
        <span className="mt-0.5 shrink-0 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
          {frame.database}
        </span>
        <button
          onClick={() => setExpandedQuery((v) => !v)}
          className={`min-w-0 flex-1 text-left font-mono text-xs text-ink-200 ${expandedQuery ? "whitespace-pre-wrap" : "truncate"}`}
          title={expandedQuery ? "Collapse query" : "Show full query"}
        >
          <span className="mr-1 text-accent">$</span>
          {frame.query}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 text-ink-400">
          {!frame.info && (
            <FrameBtn title="Re-run" onClick={() => onRerun(frame)} disabled={frame.status === "running"}>
              <RotateCw size={13} />
            </FrameBtn>
          )}
          <FrameBtn
            title="Copy query"
            onClick={async () => (await copyText(frame.query)) && toast.success("Query copied")}
          >
            <Copy size={13} />
          </FrameBtn>
          <FrameBtn title={frame.pinned ? "Unpin" : "Pin to top"} onClick={() => updateFrame(frame.id, { pinned: !frame.pinned })}>
            {frame.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </FrameBtn>
          <FrameBtn title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFullscreen((v) => !v)}>
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </FrameBtn>
          {!fullscreen && (
            <FrameBtn
              title={frame.collapsed ? "Expand" : "Collapse"}
              onClick={() => updateFrame(frame.id, { collapsed: !frame.collapsed })}
            >
              {frame.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </FrameBtn>
          )}
          <FrameBtn title="Close" onClick={() => removeFrame(frame.id)}>
            <X size={13} />
          </FrameBtn>
        </div>
      </header>
      {(!frame.collapsed || fullscreen) && body}
    </section>
  );
}

function FrameBtn({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
