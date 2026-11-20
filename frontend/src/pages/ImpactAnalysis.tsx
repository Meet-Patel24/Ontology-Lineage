import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { GraphData, ImpactRow, Level, ViewNode } from "../api/types";
import { AssetSearch } from "../components/AssetSearch";
import { DataTable } from "../components/DataTable";
import { GraphView } from "../components/GraphView";
import {
  Badge,
  ErrorPanel,
  Field,
  GraphSkeleton,
  Kpi,
  PageHeader,
  Segmented,
  TableSkeleton,
  TransformationBadge,
} from "../components/ui";
import { labelColor, transformationColor } from "../lib/colors";
import { downloadText, timestampSlug, toCsv } from "../lib/format";
import { mergeGraphs } from "../lib/graphConvert";
import { useAsync } from "../lib/useAsync";
import { useApp } from "../store/app";

const DEFAULT_IMPACT_START = "banking.customers";

export function ImpactAnalysis() {
  const params = useApp((s) => s.pageParams);
  const navigate = useApp((s) => s.navigate);
  const id = params.id || DEFAULT_IMPACT_START;
  const [depth, setDepth] = useState(6);
  const [level, setLevel] = useState<Level>("table");

  const res = useAsync(() => api.impact(id, depth, level), [id, depth, level]);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  useEffect(() => {
    if (res.data) setGraph({ nodes: res.data.nodes, edges: res.data.edges });
  }, [res.data]);

  const expand = async (node: ViewNode) => {
    const g = await api.assetNeighbors(node.id);
    const edges = g.edges.filter((e) => ["FLOWS_TO", "HAS_COLUMN", "FEEDS"].includes(e.type));
    const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
    setGraph((cur) => mergeGraphs(cur, { nodes: g.nodes.filter((n) => ids.has(n.id)), edges }));
  };

  const columns = useMemo<ColumnDef<ImpactRow, unknown>[]>(
    () => [
      { accessorKey: "depth", header: "Hop", size: 60 },
      {
        id: "source",
        header: "From",
        accessorFn: (r) => `${r.source_table ?? ""}.${r.source_column}`,
        size: 240,
        cell: (c) => <span className="font-mono text-[11px]">{c.getValue() as string}</span>,
      },
      { accessorKey: "transformation", header: "Transformation", size: 130, cell: (c) => <TransformationBadge value={c.getValue()} /> },
      { accessorKey: "target_table", header: "Impacted table", size: 200 },
      {
        accessorKey: "target_column",
        header: "Impacted column",
        size: 180,
        cell: (c) => <span className="font-medium text-ink-100">{c.getValue() as string}</span>,
      },
      { accessorKey: "pipeline", header: "Pipeline", size: 190, cell: (c) => (c.getValue() as string) ?? <span className="text-ink-500">view</span> },
      { accessorKey: "activity", header: "Activity", size: 120 },
      {
        accessorKey: "expression",
        header: "Expression",
        size: 320,
        cell: (c) => <code className="whitespace-pre-wrap font-mono text-[11px] text-emerald-700">{(c.getValue() as string) ?? ""}</code>,
      },
    ],
    [],
  );

  const s = res.data?.summary;
  const start = res.data?.start;
  const rows = res.data?.rows ?? [];

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <PageHeader
        title="Impact Analysis"
        subtitle="What breaks downstream if a table or column changes?"
        cypher={res.data?.cypher}
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="Changed asset">
          <div className="w-[440px] max-w-full">
            <AssetSearch value={null} onSelect={(r) => navigate("impact", { id: r.id })} />
          </div>
        </Field>
        <Field label="Graph level">
          <Segmented<Level>
            value={level}
            onChange={setLevel}
            options={[
              { value: "table", label: "Table" },
              { value: "column", label: "Column" },
            ]}
          />
        </Field>
        <Field label={`Depth: ${depth}`}>
          <input type="range" min={1} max={6} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="w-36 accent-[#001689]" />
        </Field>
      </div>

      {res.error && <ErrorPanel code={res.error.code} message={res.error.message} />}

      {start && s && (
        <div className="mb-4 rounded-lg border border-ink-700 bg-ink-900 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-[#111827]" style={{ background: labelColor(start.label) }}>
              {start.label}
            </span>
            <span className="font-mono">
              {start.subtitle && start.label === "Column" ? `${start.subtitle}.` : ""}
              {start.caption}
            </span>
          </div>
          <p className="mt-2 text-base font-medium text-ink-100">{s.sentence}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Impacted tables" value={s.tables} />
            <Kpi label="Impacted columns" value={s.columns} />
            <Kpi label="Pipelines" value={s.pipelines} />
            <Kpi label="Column flows" value={rows.length} tone="muted" />
          </div>
          <div className="mt-3 grid gap-3 text-xs md:grid-cols-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-400">Tables</div>
              <div className="flex flex-wrap gap-1">
                {s.table_names.length ? s.table_names.map((t) => <Badge key={t} className="bg-ink-700 normal-case text-ink-100">{t}</Badge>) : <span className="text-ink-500">none</span>}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-400">Pipelines</div>
              <div className="flex flex-wrap gap-1">
                {s.pipeline_names.length ? (
                  s.pipeline_names.map((p) => <Badge key={p} color="#AE63E4" className="normal-case">{p}</Badge>)
                ) : (
                  <span className="text-ink-500">none</span>
                )}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-400">Transformations</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(s.transformations).map(([t, n]) => (
                  <Badge key={t} color={transformationColor(t)}>
                    {t} · {n}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {res.loading && !res.data ? (
        <GraphSkeleton className="h-[520px]" />
      ) : (
        <GraphView
          data={graph}
          layout="hierarchical"
          nodeShape="box"
          onExpand={expand}
          filenameBase="impact"
          className="h-[520px]"
          emptyText="Nothing downstream of this asset."
        />
      )}

      <div className="mb-2 mt-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Impacted columns</h2>
        {rows.length > 0 && (
          <button
            onClick={() =>
              downloadText(
                toCsv(
                  ["depth", "source_table", "source_column", "transformation", "target_table", "target_column", "pipeline", "activity", "expression"],
                  rows as unknown as Record<string, unknown>[],
                ),
                `impact-${timestampSlug()}.csv`,
                "text/csv",
              )
            }
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700"
          >
            <Download size={12} /> CSV
          </button>
        )}
      </div>
      {res.loading && !res.data ? (
        <TableSkeleton />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          emptyText="No downstream column flows."
          cellText={(r, col) => String((r as unknown as Record<string, unknown>)[col] ?? "")}
          onRowClick={(r) => navigate("lineage", { id: r.target_id, direction: "upstream" })}
        />
      )}
      <p className="mt-2 text-[11px] text-ink-500">Click a row to open the upstream lineage of the impacted column.</p>
    </div>
  );
}
