import { useVirtualizer } from "@tanstack/react-virtual";
import type { Core } from "cytoscape";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Copy, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../lib/format";
import { toast } from "../store/toasts";
import { type ENode, type ERel, type NodeDetail, exploreApi } from "./api";
import { CANVAS_BG } from "./BloomCanvas";
import { DEFAULT_REL_COLOR, hashColor, nodeVisual, type Perspective } from "./perspective";
import { useView } from "./sceneStore";
import type { Visibility } from "./visibility";

const labelColor = (p: Perspective | null, l: string) => p?.labels[l]?.color ?? hashColor(l);

async function copy(text: string, what = "Value") {
  if (await copyText(text)) toast.success(`${what} copied`);
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export function Inspector({
  selection,
  nodes,
  rels,
  perspective,
  counts,
  onExpand,
  onPick,
  onClose,
}: {
  selection: { nodes: string[]; rels: string[] };
  nodes: Record<string, ENode>;
  rels: Record<string, ERel>;
  perspective: Perspective | null;
  counts: Record<string, number>;
  onExpand: (id: string, relType?: string, direction?: "in" | "out") => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const single = selection.nodes.length === 1 && selection.rels.length === 0 ? nodes[selection.nodes[0]] : null;
  const rel = selection.nodes.length === 0 && selection.rels.length === 1 ? rels[selection.rels[0]] : null;
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (!single) return;
    let cancelled = false;
    setLoading(true);
    exploreApi
      .node(single.elementId)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [single?.elementId]); // eslint-disable-line react-hooks/exhaustive-deps

  let body: React.ReactNode;
  if (single) {
    const v = perspective ? nodeVisual(single, perspective, counts, 0) : null;
    body = (
      <>
        <div className="border-b border-ink-700 px-3 py-2">
          <div className="text-sm font-semibold">{v?.caption}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {single.labels.map((l) => (
              <span key={l} className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#111827]" style={{ background: labelColor(perspective, l) }}>
                {l}
              </span>
            ))}
          </div>
          <IdRow label="elementId" value={single.elementId} />
          {typeof single.properties.id === "string" && <IdRow label="id" value={single.properties.id} />}
        </div>
        <Section title="Neighbours">
          {loading && <Loader2 size={14} className="animate-spin text-ink-400" />}
          {detail && detail.neighbours.length === 0 && <div className="text-xs text-ink-500">No relationships.</div>}
          {detail?.neighbours.map((n) => (
            <button
              key={`${n.type}-${n.direction}`}
              onClick={() => onExpand(single.elementId, n.type, n.direction)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-ink-800"
              title="Expand only these"
            >
              {n.direction === "in" ? <ArrowLeft size={12} className="text-ink-400" /> : <ArrowRight size={12} className="text-ink-400" />}
              <span className="font-mono" style={{ color: perspective?.rels[n.type]?.color ?? DEFAULT_REL_COLOR }}>
                {n.type}
              </span>
              <span className="ml-auto rounded bg-ink-700 px-1.5 text-[10px]">{n.count}</span>
            </button>
          ))}
        </Section>
        <Section title="Properties">
          <Props props={single.properties} />
        </Section>
      </>
    );
  } else if (rel) {
    const s = nodes[rel.start];
    const e = nodes[rel.end];
    body = (
      <>
        <div className="border-b border-ink-700 px-3 py-2">
          <div className="font-mono text-sm font-semibold">:{rel.type}</div>
          <div className="mt-1 text-xs text-ink-300">
            <button className="hover:text-accent" onClick={() => onPick(rel.start)}>
              {String(s?.properties.name ?? s?.labels[0] ?? rel.start)}
            </button>{" "}
            →{" "}
            <button className="hover:text-accent" onClick={() => onPick(rel.end)}>
              {String(e?.properties.name ?? e?.labels[0] ?? rel.end)}
            </button>
          </div>
          <IdRow label="elementId" value={rel.elementId} />
        </div>
        <Section title="Properties">
          <Props props={rel.properties} />
        </Section>
      </>
    );
  } else {
    body = (
      <div className="px-3 py-2 text-xs text-ink-300">
        <div className="mb-2 font-semibold text-ink-100">
          {selection.nodes.length} nodes, {selection.rels.length} relationships selected
        </div>
        <div className="max-h-[60vh] space-y-0.5 overflow-auto">
          {selection.nodes.slice(0, 300).map((id) => {
            const n = nodes[id];
            if (!n) return null;
            const v = perspective ? nodeVisual(n, perspective, counts, 0) : null;
            return (
              <button key={id} onClick={() => onPick(id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-ink-800">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: v?.color }} />
                <span className="truncate">{v?.caption}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <aside className="absolute bottom-3 right-16 top-3 z-20 flex w-80 flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-900/[0.97] shadow-2xl">
      <header className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-400">Inspector</span>
        <button onClick={onClose} className="rounded p-1 text-ink-400 hover:text-ink-100" title="Close">
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </aside>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="group mt-1.5 flex items-center gap-1 text-[10px]">
      <span className="text-ink-500">{label}</span>
      <span className="truncate font-mono text-ink-300" title={value}>
        {value}
      </span>
      <button onClick={() => void copy(value, label)} className="text-ink-500 opacity-0 hover:text-ink-100 group-hover:opacity-100">
        <Copy size={11} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ink-700 px-3 py-2">
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-ink-400">{title}</div>
      {children}
    </div>
  );
}

function Props({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <div className="text-xs text-ink-500">No properties.</div>;
  return (
    <dl className="space-y-2">
      {entries.map(([k, v]) => (
        <PropRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function PropRow({ k, v }: { k: string; v: unknown }) {
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const long = text.length > 140 || text.includes("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className="group">
      <dt className="flex items-center gap-1 text-[10px] text-ink-400">
        <span className="font-mono">{k}</span>
        <button onClick={() => void copy(text, k)} className="ml-auto opacity-0 hover:text-ink-100 group-hover:opacity-100" title="Copy">
          <Copy size={11} />
        </button>
      </dt>
      {long ? (
        <dd>
          <pre
            className={`mt-0.5 whitespace-pre-wrap break-words rounded bg-ink-950 p-1.5 font-mono text-[11px] text-emerald-800 ${open ? "" : "max-h-24 overflow-hidden"}`}
          >
            {text}
          </pre>
          <button onClick={() => setOpen((o) => !o)} className="mt-0.5 flex items-center gap-0.5 text-[10px] text-accent">
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />} {open ? "Show less" : "Show all"}
          </button>
        </dd>
      ) : (
        <dd className="break-words text-xs text-ink-100">{v === null ? <span className="text-ink-500">null</span> : text}</dd>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card list
// ---------------------------------------------------------------------------

export function CardList({
  dbTotal,
  nodes,
  visibility,
  perspective,
  counts,
  selected,
  onPick,
}: {
  dbTotal?: number | null;
  nodes: Record<string, ENode>;
  visibility: Visibility;
  perspective: Perspective | null;
  counts: Record<string, number>;
  selected: Set<string>;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = Object.keys(nodes).length;
  const [filter, setFilter] = useState("");
  const all = useMemo(() => {
    const list = Object.values(nodes).map((n) => {
      const v = perspective ? nodeVisual(n, perspective, counts, 0) : null;
      return { id: n.elementId, label: v?.label ?? n.labels[0], caption: v?.caption ?? n.elementId, color: v?.color ?? "#888" };
    });
    return list.sort((a, b) => a.label.localeCompare(b.label) || a.caption.localeCompare(b.caption));
  }, [nodes, perspective, counts]);
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? all.filter((i) => i.caption.toLowerCase().includes(q) || i.label.toLowerCase().includes(q)) : all;
  }, [all, filter]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => 34, overscan: 10 });

  return (
    <div className="pointer-events-auto w-80 overflow-hidden rounded-lg border border-ink-600 bg-ink-900/[0.97] shadow-2xl">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold">
        {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        Card list ({selected.size}/{total})
        {dbTotal != null && dbTotal > total && (
          <span className="ml-auto text-[10px] font-normal text-ink-400">{dbTotal.toLocaleString()} in database</span>
        )}
      </button>
      {open && (
        <div className="border-t border-ink-700">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter cards"
            className="w-full border-b border-ink-700 bg-transparent px-3 py-1.5 text-xs outline-none placeholder:text-ink-500"
          />
          <div ref={scrollRef} className="h-[38vh] overflow-auto">
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const it = items[vi.index];
                const st = visibility.nodes.get(it.id);
                return (
                  <button
                    key={it.id}
                    onClick={() => onPick(it.id)}
                    className={`absolute left-0 flex w-full items-center gap-2 px-3 text-left text-xs hover:bg-ink-800 ${selected.has(it.id) ? "bg-accent/15" : ""} ${st === "gone" ? "opacity-40" : ""}`}
                    style={{ top: vi.start, height: vi.size }}
                    title={st === "gone" ? "Hidden" : undefined}
                  >
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#111827]" style={{ background: it.color }}>
                      {it.label}
                    </span>
                    <span className="truncate">{it.caption}</span>
                  </button>
                );
              })}
            </div>
            {items.length === 0 && <div className="px-3 py-4 text-center text-xs text-ink-500">No nodes.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export function Legend({
  nodes,
  rels,
  visibility,
  perspective,
}: {
  nodes: Record<string, ENode>;
  rels: Record<string, ERel>;
  visibility: Visibility;
  perspective: Perspective | null;
}) {
  const [open, setOpen] = useState(true);
  const legendHidden = useView((s) => s.legendHidden);
  const toggle = useView((s) => s.toggleLegend);
  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    Object.keys(nodes).forEach((id) => {
      const l = visibility.styleLabels.get(id) ?? "?";
      m.set(l, (m.get(l) ?? 0) + 1);
    });
    return [...m.entries()].sort();
  }, [nodes, visibility]);
  const relCounts = useMemo(() => {
    const m = new Map<string, number>();
    Object.values(rels).forEach((r) => m.set(r.type, (m.get(r.type) ?? 0) + 1));
    return [...m.entries()].sort();
  }, [rels]);
  if (!labelCounts.length) return null;
  return (
    <div className="pointer-events-auto max-w-[min(900px,60vw)] rounded-lg border border-ink-600 bg-ink-900/[0.95] px-2 py-1.5 text-[11px] shadow-xl">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-ink-400 hover:text-ink-100">
        {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />} Legend
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {labelCounts.map(([l, n]) => {
            const off = legendHidden.includes(`n:${l}`);
            return (
              <button key={l} onClick={() => toggle(`n:${l}`)} className={`flex items-center gap-1 ${off ? "opacity-35 line-through" : ""}`} title="Show / hide">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: labelColor(perspective, l) }} />
                {l} <span className="text-ink-500">{n}</span>
              </button>
            );
          })}
          {relCounts.map(([t, n]) => {
            const off = legendHidden.includes(`r:${t}`);
            return (
              <button key={t} onClick={() => toggle(`r:${t}`)} className={`flex items-center gap-1 font-mono ${off ? "opacity-35 line-through" : ""}`} title="Show / hide">
                <span className="h-0.5 w-4" style={{ background: perspective?.rels[t]?.color ?? DEFAULT_REL_COLOR }} />
                {t} <span className="text-ink-500">{n}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

export function Minimap({ getCy }: { getCy: () => Core | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const W = 200;
  const H = 130;

  useEffect(() => {
    const cy = getCy();
    if (!cy) return;
    let raf = 0;
    let transform = { s: 1, ox: 0, oy: 0 };
    const draw = () => {
      raf = 0;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(0, 0, W, H);
      const nodes = cy.nodes(":visible");
      if (nodes.empty()) return;
      const bb = nodes.boundingBox({});
      const s = Math.min((W - 10) / Math.max(bb.w, 1), (H - 10) / Math.max(bb.h, 1));
      const ox = (W - bb.w * s) / 2 - bb.x1 * s;
      const oy = (H - bb.h * s) / 2 - bb.y1 * s;
      transform = { s, ox, oy };
      nodes.forEach((n) => {
        const p = n.position();
        ctx.fillStyle = n.data("color") ?? "#888";
        ctx.beginPath();
        ctx.arc(p.x * s + ox, p.y * s + oy, Math.max(1.5, (n.data("size") ?? 40) * s * 0.5), 0, Math.PI * 2);
        ctx.fill();
      });
      const ext = cy.extent();
      ctx.strokeStyle = "#001689";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ext.x1 * s + ox, ext.y1 * s + oy, ext.w * s, ext.h * s);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    cy.on("render viewport add remove position", schedule);
    schedule();
    const canvas = canvasRef.current!;
    const onClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - transform.ox) / transform.s;
      const y = (e.clientY - r.top - transform.oy) / transform.s;
      cy.animate({ pan: { x: cy.width() / 2 - x * cy.zoom(), y: cy.height() / 2 - y * cy.zoom() } }, { duration: 200 });
    };
    canvas.addEventListener("click", onClick);
    return () => {
      cy.off("render viewport add remove position", schedule);
      canvas.removeEventListener("click", onClick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [getCy]);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      className="cursor-pointer rounded-lg border border-ink-600 shadow-xl"
      title="Minimap: click to move the view"
    />
  );
}
