import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { GraphData, PipelineRow } from "../api/types";
import { DataTable } from "../components/DataTable";
import { GraphView } from "../components/GraphView";
import { Badge, ErrorPanel, Field, GraphSkeleton, Kpi, PageHeader, Skeleton, TableSkeleton } from "../components/ui";
import { useAsync } from "../lib/useAsync";

const listCell = (v: unknown) => {
  const arr = (v as string[]) ?? [];
  if (!arr.length) return <span className="text-ink-500">-</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {arr.map((x) => (
        <span key={x} className="font-mono text-[11px]">
          {x}
        </span>
      ))}
    </span>
  );
};

export function Pipelines() {
  const res = useAsync(() => api.pipelines(), []);
  const [pipeline, setPipeline] = useState<string>("");
  const s = res.data?.summary;

  const pipelineNames = useMemo(() => [...new Set((res.data?.rows ?? []).map((r) => r.pipeline))].sort(), [res.data]);
  const rows = useMemo(() => (res.data?.rows ?? []).filter((r) => !pipeline || r.pipeline === pipeline), [res.data, pipeline]);

  // Filter the graph to the selected pipeline: pipeline node + its activities + their neighbours.
  const graph = useMemo<GraphData>(() => {
    const nodes = res.data?.nodes ?? [];
    const edges = res.data?.edges ?? [];
    if (!pipeline) return { nodes, edges };
    const pid = rows[0]?.pipeline_id;
    const acts = new Set(rows.map((r) => r.activity_id));
    const keepEdges = edges.filter(
      (e) => (e.type === "CONTAINS" && e.source === pid) || acts.has(e.source) || acts.has(e.target),
    );
    const ids = new Set(keepEdges.flatMap((e) => [e.source, e.target]));
    if (pid) ids.add(pid);
    return { nodes: nodes.filter((n) => ids.has(n.id)), edges: keepEdges };
  }, [res.data, pipeline, rows]);

  const columns = useMemo<ColumnDef<PipelineRow, unknown>[]>(
    () => [
      { accessorKey: "pipeline", header: "Pipeline", size: 210, cell: (c) => <span className="font-medium">{c.getValue() as string}</span> },
      { accessorKey: "activity", header: "Activity", size: 160 },
      {
        accessorKey: "activity_type",
        header: "Type",
        size: 120,
        cell: (c) => (c.getValue() ? <Badge color="#fb7185">{c.getValue() as string}</Badge> : null),
      },
      { accessorKey: "reads_from", header: "Reads from", size: 200, cell: (c) => listCell(c.getValue()), sortingFn: "alphanumeric" },
      { accessorKey: "writes_to", header: "Writes to", size: 200, cell: (c) => listCell(c.getValue()), sortingFn: "alphanumeric" },
      { accessorKey: "next", header: "Precedes / invokes", size: 220, cell: (c) => listCell(c.getValue()), enableSorting: false },
      {
        id: "sql",
        header: "Query / pre-copy script",
        accessorFn: (r) => [r.query, r.pre_copy_script].filter(Boolean).join("\n"),
        size: 320,
        cell: (c) => <code className="whitespace-pre-wrap font-mono text-[11px] text-emerald-300">{c.getValue() as string}</code>,
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <PageHeader title="Pipelines" subtitle="Fabric pipelines, their activities and the tables they read from and write to." cypher={res.data?.cypher}>
        <Field label="Pipeline">
          <select
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
            className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-xs text-ink-100"
          >
            <option value="">All pipelines</option>
            {pipelineNames.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
      </PageHeader>
      {res.error && <ErrorPanel code={res.error.code} message={res.error.message} />}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {s ? (
          <>
            <Kpi label="Pipelines" value={s.pipelines} />
            <Kpi label="Activities" value={s.activities} />
            <Kpi label="Source tables" value={s.sources} />
            <Kpi label="Target tables" value={s.targets} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[74px]" />)
        )}
      </div>
      {res.loading && !res.data ? (
        <GraphSkeleton className="h-[640px]" />
      ) : (
        <GraphView data={graph} layout="hierarchical" nodeShape="box" filenameBase="pipelines" className="h-[640px]" emptyText="No pipelines found." />
      )}
      <h2 className="mb-2 mt-6 text-sm font-semibold">Activities</h2>
      {res.loading && !res.data ? (
        <TableSkeleton />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          rowHeight={44}
          emptyText="No activities."
          cellText={(r, col) => {
            const v = (r as unknown as Record<string, unknown>)[col];
            return Array.isArray(v) ? v.join(", ") : String(v ?? "");
          }}
        />
      )}
    </div>
  );
}
