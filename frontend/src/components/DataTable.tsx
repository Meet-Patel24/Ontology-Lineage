import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { copyText } from "../lib/format";
import { toast } from "../store/toasts";

interface Props<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  /** Max height of the scroll area (CSS). */
  maxHeight?: string;
  rowHeight?: number;
  emptyText?: string;
  /** Text copied by the per-cell copy button. */
  cellText?: (row: T, columnId: string) => string;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  data,
  columns,
  maxHeight = "420px",
  rowHeight = 34,
  emptyText = "No rows.",
  cellText,
  onRowClick,
}: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
    defaultColumn: { size: 180, minSize: 60, maxSize: 1200 },
  });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    measureElement: (el) => el.getBoundingClientRect().height,
  });
  const items = virtualizer.getVirtualItems();
  const totalWidth = table.getTotalSize();
  const padTop = items.length ? items[0].start : 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;

  return (
    <div ref={scrollRef} className="shrink-0 overflow-auto rounded-md border border-ink-700" style={{ maxHeight }}>
      <table className="border-collapse text-xs" style={{ width: Math.max(totalWidth, 100), tableLayout: "fixed" }}>
        <thead className="sticky top-0 z-10 bg-ink-850">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    style={{ width: h.getSize() }}
                    className="relative select-none border-b border-r border-ink-700 px-2 py-1.5 text-left font-semibold text-ink-200"
                  >
                    <button
                      className="flex w-full items-center gap-1 truncate"
                      onClick={h.column.getToggleSortingHandler()}
                      disabled={!h.column.getCanSort()}
                      title="Sort"
                    >
                      <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                      {h.column.getCanSort() &&
                        (sorted === "asc" ? (
                          <ArrowUp size={12} />
                        ) : sorted === "desc" ? (
                          <ArrowDown size={12} />
                        ) : (
                          <ArrowUpDown size={11} className="text-ink-500" />
                        ))}
                    </button>
                    <div
                      onMouseDown={h.getResizeHandler()}
                      onTouchStart={h.getResizeHandler()}
                      onDoubleClick={() => h.column.resetSize()}
                      className={`absolute right-0 top-0 h-full w-1.5 cursor-col-resize ${h.column.getIsResizing() ? "bg-accent" : "hover:bg-ink-500"}`}
                    />
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr>
              <td style={{ height: padTop }} colSpan={columns.length} />
            </tr>
          )}
          {items.map((vi) => {
            const row = rows[vi.index];
            return (
              <tr
                key={row.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={`border-b border-ink-800 odd:bg-ink-900/40 hover:bg-ink-800 ${onRowClick ? "cursor-pointer" : ""}`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    style={{ width: cell.column.getSize() }}
                    className="group relative border-r border-ink-800 px-2 py-1.5 align-top"
                  >
                    <div className="overflow-hidden">{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
                    {cellText && (
                      <button
                        title="Copy cell"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await copyText(cellText(row.original, cell.column.id))) toast.success("Cell copied");
                        }}
                        className="absolute right-1 top-1 rounded bg-ink-800 p-0.5 text-ink-400 opacity-0 hover:text-ink-100 group-hover:opacity-100"
                      >
                        <Copy size={11} />
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          {padBottom > 0 && (
            <tr>
              <td style={{ height: padBottom }} colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
      {rows.length === 0 && <div className="px-3 py-6 text-center text-xs text-ink-400">{emptyText}</div>}
    </div>
  );
}
