import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { PiiRow } from "../api/types";
import { DataTable } from "../components/DataTable";
import { GraphView } from "../components/GraphView";
import { ErrorPanel, GraphSkeleton, Kpi, PageHeader, Segmented, StatusBadge, TableSkeleton, TransformationBadge, Skeleton } from "../components/ui";
import { downloadText, timestampSlug, toCsv } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { useApp } from "../store/app";

type Filter = "all" | "OK" | "VIOLATION" | "NOT MOVED";

export function PiiTracker() {
  const res = useAsync(() => api.pii(), []);
  const navigate = useApp((s) => s.navigate);
  const [filter, setFilter] = useState<Filter>("all");
  const s = res.data?.summary;
  const rows = useMemo(
    () => (res.data?.rows ?? []).filter((r) => filter === "all" || r.status === filter),
    [res.data, filter],
  );

  const columns = useMemo<ColumnDef<PiiRow, unknown>[]>(
    () => [
      {
        id: "source",
        header: "PII source column",
        accessorFn: (r) => `${r.source_table}.${r.source_column}`,
        size: 240,
        cell: (c) => <span className="font-mono text-[11px] text-ink-100">{c.getValue() as string}</span>,
      },
      {
        id: "classification",
        header: "Classification",
        accessorFn: (r) => `${r.classification}${r.comment ? " · " + r.comment : ""}`,
        size: 230,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span>
              <span className="mr-1 rounded bg-red-500/20 px-1 text-[10px] font-semibold text-red-700">{r.classification}</span>
              <span className="text-ink-300">{r.comment}</span>
            </span>
          );
        },
      },
      { accessorKey: "treatment", header: "Treatment", size: 110, cell: (c) => <TransformationBadge value={c.getValue()} /> },
      {
        id: "target",
        header: "Target column",
        accessorFn: (r) => (r.target_column ? `${r.target_table}.${r.target_column}` : ""),
        size: 260,
        cell: (c) => {
          const r = c.row.original;
          if (!r.target_column) return <span className="text-ink-500">-</span>;
          return (
            <span className="font-mono text-[11px]">
              {r.target_table}.{r.target_column}
              {r.target_classification && <span className="ml-1 text-[10px] text-amber-700">({r.target_classification})</span>}
            </span>
          );
        },
      },
      { accessorKey: "pipeline", header: "Pipeline", size: 180, cell: (c) => (c.getValue() as string) ?? <span className="text-ink-500">-</span> },
      {
        accessorKey: "expression",
        header: "Masking expression",
        size: 280,
        cell: (c) => <code className="whitespace-pre-wrap font-mono text-[11px] text-emerald-700">{(c.getValue() as string) ?? ""}</code>,
      },
      { accessorKey: "status", header: "Status", size: 110, cell: (c) => <StatusBadge status={c.getValue() as string} /> },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <PageHeader
        title="PII Tracker"
        subtitle="Every PII column, how it is treated on the way to Fabric, and whether that is compliant (DIRECT or CAST into Fabric is a violation)."
        cypher={res.data?.cypher}
      />
      {res.error && <ErrorPanel code={res.error.code} message={res.error.message} />}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {s ? (
          <>
            <Kpi label="PII source columns" value={s.pii_columns} />
            <Kpi label="Masked flows" value={s.masked_flows} tone="good" />
            <Kpi label="Violations" value={s.violations} tone={s.violations ? "bad" : "good"} />
            <Kpi label="Not moved" value={s.not_moved} tone="muted" hint="PII columns that do not flow anywhere" />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[74px]" />)
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All${res.data ? ` (${res.data.rows?.length ?? 0})` : ""}` },
            { value: "OK", label: `OK${s ? ` (${s.ok})` : ""}` },
            { value: "VIOLATION", label: `Violations${s ? ` (${s.violations})` : ""}` },
            { value: "NOT MOVED", label: `Not moved${s ? ` (${s.not_moved})` : ""}` },
          ]}
        />
        {rows.length > 0 && (
          <button
            onClick={() =>
              downloadText(
                toCsv(
                  ["source_table", "source_column", "classification", "comment", "treatment", "target_table", "target_column", "pipeline", "status"],
                  rows as unknown as Record<string, unknown>[],
                ),
                `pii-${timestampSlug()}.csv`,
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
          emptyText="No PII columns match this filter."
          cellText={(r, col) => String((r as unknown as Record<string, unknown>)[col] ?? "")}
          onRowClick={(r) => navigate("lineage", { id: r.source_id, direction: "downstream" })}
        />
      )}

      <h2 className="mb-2 mt-6 text-sm font-semibold">PII flow graph</h2>
      {res.loading && !res.data ? (
        <GraphSkeleton className="h-[520px]" />
      ) : (
        <GraphView
          data={{ nodes: res.data?.nodes ?? [], edges: res.data?.edges ?? [] }}
          layout="hierarchical"
          nodeShape="box"
          filenameBase="pii"
          className="h-[520px]"
          emptyText="No PII columns found."
        />
      )}
    </div>
  );
}
