import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Direction, GraphData, Level, ViewNode } from "../api/types";
import { AssetSearch } from "../components/AssetSearch";
import { GraphView } from "../components/GraphView";
import { ErrorPanel, Field, GraphSkeleton, PageHeader, Segmented } from "../components/ui";
import { labelColor } from "../lib/colors";
import { mergeGraphs } from "../lib/graphConvert";
import { useAsync } from "../lib/useAsync";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";

export const DEFAULT_LINEAGE_START = "fact.loan_portfolio.risk_bucket";

export function LineageExplorer() {
  const params = useApp((s) => s.pageParams);
  const navigate = useApp((s) => s.navigate);
  const id = params.id || DEFAULT_LINEAGE_START;
  const [direction, setDirection] = useState<Direction>((params.direction as Direction) || "both");
  const [level, setLevel] = useState<Level>((params.level as Level) || "column");
  const [depth, setDepth] = useState<number>(Number(params.depth) || 3);

  const res = useAsync(() => api.lineage(id, direction, depth, level), [id, direction, depth, level]);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  useEffect(() => {
    if (res.data) setGraph({ nodes: res.data.nodes, edges: res.data.edges });
  }, [res.data]);

  const expand = async (node: ViewNode) => {
    const g = await api.assetNeighbors(node.id);
    // Neighbourhood expansion keeps lineage-relevant relationships only.
    const keep = new Set(["FLOWS_TO", "HAS_COLUMN", "FEEDS", "READS_FROM", "WRITES_TO", "CONTAINS", "REPRESENTS", "CLASSIFIED_AS"]);
    const edges = g.edges.filter((e) => keep.has(e.type));
    const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
    setGraph((cur) => mergeGraphs(cur, { nodes: g.nodes.filter((n) => ids.has(n.id)), edges }));
  };

  const start = res.data?.start;
  const flowEdges = graph.edges.filter((e) => e.type === "FLOWS_TO").length;

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <PageHeader
        title="Lineage Explorer"
        subtitle="Trace where data comes from and where it goes, column by column or table by table."
        cypher={res.data?.cypher}
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="Start from">
          <div className="w-[440px] max-w-full">
            <AssetSearch
              value={null}
              onSelect={(r) => navigate("lineage", { id: r.id })}
            />
          </div>
        </Field>
        <Field label="Direction">
          <Segmented<Direction>
            value={direction}
            onChange={setDirection}
            options={[
              { value: "upstream", label: "Upstream" },
              { value: "downstream", label: "Downstream" },
              { value: "both", label: "Both" },
            ]}
          />
        </Field>
        <Field label="Level">
          <Segmented<Level>
            value={level}
            onChange={setLevel}
            options={[
              { value: "column", label: "Column" },
              { value: "table", label: "Table" },
            ]}
          />
        </Field>
        <Field label={`Depth: ${depth}`}>
          <input
            type="range"
            min={1}
            max={6}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-36 accent-[#4f9cf9]"
          />
        </Field>
      </div>

      {start && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-300">
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-ink-950" style={{ background: labelColor(start.label) }}>
            {start.label}
          </span>
          <span className="font-mono text-ink-100">
            {start.subtitle && start.label === "Column" ? `${start.subtitle}.` : ""}
            {start.caption}
          </span>
          <span className="text-ink-500">·</span>
          <span>
            {graph.nodes.length} nodes, {flowEdges} column flows
          </span>
          <button
            className="ml-2 text-accent hover:underline"
            onClick={() => {
              navigator.clipboard?.writeText(start.id).then(() => toast.success("Id copied"));
            }}
          >
            copy id
          </button>
        </div>
      )}

      {res.error && <ErrorPanel code={res.error.code} message={res.error.message} />}
      {res.loading && !res.data ? (
        <GraphSkeleton className="h-[620px]" />
      ) : (
        <div className="relative">
          {res.loading && <div className="absolute right-3 top-3 z-20 animate-pulse text-xs text-accent">Loading…</div>}
          <GraphView
            data={graph}
            layout="hierarchical"
            nodeShape="box"
            onExpand={expand}
            filenameBase="lineage"
            className="h-[620px]"
            emptyText="No lineage found for this asset at this depth."
          />
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-500">
        Click an edge to see its transformation, SQL expression, pipeline and activity. Double-click a node to expand it; right-click for
        more actions. The yellow ring marks the start node, red rings mark PII columns.
      </p>
    </div>
  );
}
