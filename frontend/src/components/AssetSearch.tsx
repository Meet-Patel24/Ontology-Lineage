import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SearchRow } from "../api/types";
import { labelColor } from "../lib/colors";

interface Props {
  value: SearchRow | null;
  onSelect: (row: SearchRow) => void;
  placeholder?: string;
}

/** Debounced search over tables, views, columns, pipelines and concepts. */
export function AssetSearch({ value, onSelect, placeholder = "Search tables, views, columns, pipelines, concepts…" }: Props) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .search(term)
        .then((r) => !cancelled && (setRows(r.rows), setActive(0)))
        .catch(() => !cancelled && setRows([]))
        .finally(() => !cancelled && setLoading(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const choose = (r: SearchRow) => {
    onSelect(r);
    setQ("");
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-xl">
      <div className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-900 px-2.5 focus-within:border-accent">
        <Search size={15} className="text-ink-400" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, rows.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && rows[active]) choose(rows[active]);
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={value ? `${value.label}: ${value.subtitle ? value.subtitle + "." : ""}${value.caption}` : placeholder}
          className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-ink-400"
        />
        {loading && <Loader2 size={14} className="animate-spin text-ink-400" />}
      </div>
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-md border border-ink-700 bg-ink-850 py-1 shadow-2xl">
          {rows.length === 0 && !loading && <div className="px-3 py-2 text-xs text-ink-400">No matches</div>}
          {rows.map((r, i) => (
            <button
              key={r.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${i === active ? "bg-ink-700" : ""}`}
            >
              <span
                className="w-24 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold text-ink-950"
                style={{ background: labelColor(r.label) }}
              >
                {r.label}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-ink-100">{r.caption}</span>
                {r.subtitle && <span className="ml-2 text-ink-400">{r.subtitle}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
