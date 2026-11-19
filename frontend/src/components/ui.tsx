// Small shared UI primitives.
import { AlertTriangle, Code2, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { transformationColor } from "../lib/colors";
import { useApp } from "../store/app";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-ink-800 ${className}`} />;
}

export function GraphSkeleton({ className = "h-[480px]" }: { className?: string }) {
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-md border border-ink-700 bg-ink-950 ${className}`}>
      <div className="absolute inset-0 flex items-center justify-center gap-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-4">
            {[0, 1, 2].slice(0, 1 + ((i + 1) % 3)).map((j) => (
              <Skeleton key={j} className="h-10 w-36" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-7 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full opacity-70" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-700 px-6 py-10 text-center">
      <div className="text-ink-500">{icon ?? <Inbox size={28} />}</div>
      <div className="text-sm font-semibold text-ink-200">{title}</div>
      {children && <div className="max-w-md text-xs text-ink-400">{children}</div>}
    </div>
  );
}

export function ErrorPanel({ code, message }: { code?: string; message: string }) {
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-red-300">
        <AlertTriangle size={14} /> {code ?? "Error"}
      </div>
      <div className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-red-100">{message}</div>
    </div>
  );
}

export function Badge({ children, color, className = "" }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}
      style={color ? { background: color + "2e", color, border: `1px solid ${color}66` } : undefined}
    >
      {children}
    </span>
  );
}

export function TransformationBadge({ value }: { value: unknown }) {
  if (!value) return <span className="text-ink-500">-</span>;
  return <Badge color={transformationColor(value)}>{String(value)}</Badge>;
}

const STATUS_COLORS: Record<string, string> = { OK: "#10b981", VIOLATION: "#ef4444", "NOT MOVED": "#94a3b8" };
export function StatusBadge({ status }: { status: string }) {
  return <Badge color={STATUS_COLORS[status] ?? "#94a3b8"}>{status}</Badge>;
}

export function Kpi({ label, value, tone = "default", hint }: { label: string; value: ReactNode; tone?: "default" | "good" | "bad" | "muted"; hint?: string }) {
  const toneCls = {
    default: "text-ink-100",
    good: "text-emerald-400",
    bad: "text-red-400",
    muted: "text-ink-300",
  }[tone];
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, cypher, children }: { title: string; subtitle?: string; cypher?: string; children?: ReactNode }) {
  const openInQuery = useApp((s) => s.openInQuery);
  const mode = useApp((s) => s.health?.mode);
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {children}
        {cypher && (
          <button
            onClick={() => openInQuery(cypher)}
            className="flex items-center gap-1.5 rounded-md border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:border-accent hover:text-accent"
            title={mode === "snapshot" ? "Open the Cypher (live queries are unavailable in snapshot mode)" : "Load the underlying Cypher into the Query editor"}
          >
            <Code2 size={14} /> Open in Query
          </button>
        )}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-ink-600 bg-ink-900 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs transition ${o.value === value ? "bg-accent text-ink-950 font-semibold" : "text-ink-300 hover:text-ink-100"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-ink-400">{label}</span>
      {children}
    </label>
  );
}
