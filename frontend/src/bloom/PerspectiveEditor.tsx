import { Copy, Download, Eye, EyeOff, Pencil, Plus, Trash2, Upload, Wand2, X } from "lucide-react";
import { useRef, useState } from "react";
import { downloadText } from "../lib/format";
import { toast } from "../store/toasts";
import type { ExploreSchema } from "./api";
import {
  DEFAULT_REL_COLOR,
  generatePerspective,
  hashColor,
  type LabelStyle,
  type Perspective,
  type RelStyle,
  type RuleOp,
  type StyleRule,
  uid,
  usePerspectives,
} from "./perspective";

type Tab = "labels" | "rels" | "rules";

export function PerspectiveEditor({ schema, onClose }: { schema: ExploreSchema | null; onClose: () => void }) {
  const store = usePerspectives();
  const p = store.active();
  const [tab, setTab] = useState<Tab>("labels");
  const fileRef = useRef<HTMLInputElement>(null);
  if (!p) return null;

  const update = (fn: (x: Perspective) => Perspective) => store.update(p.id, fn);
  const setLabel = (l: string, patch: Partial<LabelStyle>) =>
    update((x) => {
      const base: LabelStyle = x.labels[l] ?? { color: hashColor(l), size: 44, caption: "name", hidden: false };
      return { ...x, labels: { ...x.labels, [l]: { ...base, ...patch } } };
    });
  const setRel = (t: string, patch: Partial<RelStyle>) =>
    update((x) => {
      const base: RelStyle = x.rels[t] ?? { color: DEFAULT_REL_COLOR, width: 1.5, showCaption: true, hidden: false };
      return { ...x, rels: { ...x.rels, [t]: { ...base, ...patch } } };
    });

  const labels = [...new Set([...(schema?.labels.map((l) => l.name) ?? []), ...Object.keys(p.labels)])].sort();
  const relTypes = [...new Set([...(schema?.relationship_types.map((r) => r.name) ?? []), ...Object.keys(p.rels)])].sort();

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as Perspective;
      if (!data || typeof data.labels !== "object") throw new Error("Not a perspective file");
      store.add({ ...data, id: uid(), name: data.name ? `${data.name} (imported)` : "Imported perspective", rules: data.rules ?? [], rels: data.rels ?? {} });
      toast.success("Perspective imported");
    } catch (e) {
      toast.error("Import failed", (e as Error).message);
    }
  };

  return (
    <aside className="absolute bottom-3 left-3 top-3 z-30 flex w-[380px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-900/[0.98] shadow-2xl">
      <header className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-ink-400">Perspective</span>
        <select
          value={p.id}
          onChange={(e) => store.setActive(e.target.value)}
          className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-xs"
        >
          {store.perspectives.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button onClick={onClose} className="rounded p-1 text-ink-400 hover:text-ink-100" title="Close">
          <X size={15} />
        </button>
      </header>
      <div className="flex flex-wrap gap-1 border-b border-ink-700 px-3 py-2">
        <Btn icon={<Pencil size={12} />} onClick={() => {
          const n = window.prompt("Rename perspective", p.name);
          if (n?.trim()) update((x) => ({ ...x, name: n.trim() }));
        }}>Rename</Btn>
        <Btn icon={<Copy size={12} />} onClick={() => store.add({ ...structuredClone(p), id: uid(), name: `${p.name} copy` })}>Duplicate</Btn>
        <Btn icon={<Wand2 size={12} />} onClick={() => schema && store.add(generatePerspective(schema, "Generated perspective"))}>New from schema</Btn>
        <Btn icon={<Download size={12} />} onClick={() => downloadText(JSON.stringify(p, null, 2), `${p.name.replace(/\W+/g, "_")}.perspective.json`, "application/json")}>Export</Btn>
        <Btn icon={<Upload size={12} />} onClick={() => fileRef.current?.click()}>Import</Btn>
        <Btn
          icon={<Trash2 size={12} />}
          onClick={() => {
            if (store.perspectives.length <= 1) return toast.warning("Keep at least one perspective");
            if (window.confirm(`Delete perspective "${p.name}"?`)) store.remove(p.id);
          }}
        >
          Delete
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>
      <div className="flex border-b border-ink-700 text-xs">
        {(["labels", "rels", "rules"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 border-b-2 py-1.5 ${tab === t ? "border-accent text-ink-100" : "border-transparent text-ink-400"}`}
          >
            {t === "labels" ? "Labels" : t === "rels" ? "Relationships" : `Rules (${p.rules.length})`}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        {tab === "labels" && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-ink-300">
              <input type="checkbox" checked={p.sizeByDegree} onChange={(e) => update((x) => ({ ...x, sizeByDegree: e.target.checked }))} />
              Size nodes by degree
            </label>
            {labels.map((l) => {
              const s = p.labels[l] ?? { color: hashColor(l), size: 44, caption: "name", hidden: false };
              const props = (schema?.node_properties[l] ?? []).map((x) => x.name);
              return (
                <div key={l} className="rounded border border-ink-700 p-2">
                  <div className="flex items-center gap-2">
                    <input type="color" value={toHex(s.color)} onChange={(e) => setLabel(l, { color: e.target.value })} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent" />
                    <span className="flex-1 font-semibold">{l}</span>
                    <button onClick={() => setLabel(l, { hidden: !s.hidden })} title={s.hidden ? "Show" : "Hide"} className="text-ink-400 hover:text-ink-100">
                      {s.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-[60px_1fr] items-center gap-x-2 gap-y-1.5">
                    <span className="text-ink-400">Caption</span>
                    <input
                      list={`props-${l}`}
                      value={s.caption}
                      onChange={(e) => setLabel(l, { caption: e.target.value })}
                      placeholder="name or {table}.{name}"
                      className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono"
                    />
                    <datalist id={`props-${l}`}>
                      {props.map((x) => (
                        <option key={x} value={x} />
                      ))}
                    </datalist>
                    <span className="text-ink-400">Size {s.size}</span>
                    <input type="range" min={16} max={110} value={s.size} onChange={(e) => setLabel(l, { size: Number(e.target.value) })} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {tab === "rels" && (
          <div className="space-y-2">
            {relTypes.map((t) => {
              const s = p.rels[t] ?? { color: DEFAULT_REL_COLOR, width: 1.5, showCaption: true, hidden: false };
              return (
                <div key={t} className="rounded border border-ink-700 p-2">
                  <div className="flex items-center gap-2">
                    <input type="color" value={toHex(s.color)} onChange={(e) => setRel(t, { color: e.target.value })} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent" />
                    <span className="flex-1 font-mono font-semibold">{t}</span>
                    <button onClick={() => setRel(t, { hidden: !s.hidden })} title={s.hidden ? "Show" : "Hide"} className="text-ink-400 hover:text-ink-100">
                      {s.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-ink-400">Width {s.width}</span>
                    <input type="range" min={0.5} max={8} step={0.5} value={s.width} onChange={(e) => setRel(t, { width: Number(e.target.value) })} className="flex-1" />
                    <label className="flex items-center gap-1 text-ink-300">
                      <input type="checkbox" checked={s.showCaption} onChange={(e) => setRel(t, { showCaption: e.target.checked })} /> Caption
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {tab === "rules" && <RulesTab p={p} schema={schema} update={update} />}
      </div>
    </aside>
  );
}

const OPS: { value: RuleOp; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "contains", label: "contains" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "true", label: "is true" },
  { value: "false", label: "is false" },
  { value: "exists", label: "exists" },
];

function RulesTab({ p, schema, update }: { p: Perspective; schema: ExploreSchema | null; update: (fn: (x: Perspective) => Perspective) => void }) {
  const setRule = (id: string, patch: Partial<StyleRule>) => update((x) => ({ ...x, rules: x.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const add = (target: "node" | "rel") =>
    update((x) => ({
      ...x,
      rules: [...x.rules, { id: uid(), enabled: true, target, on: "*", property: "", op: "eq", value: "", style: target === "node" ? { borderColor: "#ef4444" } : { color: "#ef4444" } }],
    }));
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-ink-400">Rules are applied in order on top of the label / relationship styles, e.g. Column where is_pii is true → red border.</p>
      {p.rules.map((r) => {
        const ons = r.target === "node" ? schema?.labels.map((l) => l.name) ?? [] : schema?.relationship_types.map((t) => t.name) ?? [];
        const props =
          r.target === "node"
            ? (r.on === "*" ? Object.values(schema?.node_properties ?? {}).flat() : schema?.node_properties[r.on] ?? []).map((x) => x.name)
            : (r.on === "*" ? Object.values(schema?.relationship_properties ?? {}).flat() : schema?.relationship_properties[r.on] ?? []).map((x) => x.name);
        const needsValue = !["true", "false", "exists"].includes(r.op);
        return (
          <div key={r.id} className={`space-y-1.5 rounded border border-ink-700 p-2 ${r.enabled ? "" : "opacity-50"}`}>
            <div className="flex items-center gap-1.5">
              <input type="checkbox" checked={r.enabled} onChange={(e) => setRule(r.id, { enabled: e.target.checked })} title="Enabled" />
              <span className="text-ink-400">{r.target === "node" ? "Node" : "Relationship"}</span>
              <select value={r.on} onChange={(e) => setRule(r.id, { on: e.target.value })} className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-850 px-1 py-0.5">
                <option value="*">any</option>
                {ons.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <button onClick={() => update((x) => ({ ...x, rules: x.rules.filter((y) => y.id !== r.id) }))} className="text-ink-400 hover:text-red-700" title="Delete rule">
                <Trash2 size={13} />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-ink-400">where</span>
              <input list={`rp-${r.id}`} value={r.property} onChange={(e) => setRule(r.id, { property: e.target.value })} placeholder="property" className="w-24 min-w-0 flex-1 rounded border border-ink-600 bg-ink-850 px-1 py-0.5 font-mono" />
              <datalist id={`rp-${r.id}`}>
                {[...new Set(props)].map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
              <select value={r.op} onChange={(e) => setRule(r.id, { op: e.target.value as RuleOp })} className="rounded border border-ink-600 bg-ink-850 px-1 py-0.5">
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {needsValue && <input value={r.value} onChange={(e) => setRule(r.id, { value: e.target.value })} placeholder="value" className="w-20 rounded border border-ink-600 bg-ink-850 px-1 py-0.5" />}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-400">then</span>
              {r.target === "node" ? (
                <>
                  <ColorField label="fill" value={r.style.color} onChange={(c) => setRule(r.id, { style: { ...r.style, color: c } })} />
                  <ColorField label="border" value={r.style.borderColor} onChange={(c) => setRule(r.id, { style: { ...r.style, borderColor: c } })} />
                  <label className="flex items-center gap-1 text-ink-400">
                    size
                    <input type="number" value={r.style.size ?? ""} onChange={(e) => setRule(r.id, { style: { ...r.style, size: e.target.value ? Number(e.target.value) : undefined } })} className="w-12 rounded border border-ink-600 bg-ink-850 px-1" />
                  </label>
                </>
              ) : (
                <>
                  <ColorField label="colour" value={r.style.color} onChange={(c) => setRule(r.id, { style: { ...r.style, color: c } })} />
                  <label className="flex items-center gap-1 text-ink-400">
                    width
                    <input type="number" step={0.5} value={r.style.width ?? ""} onChange={(e) => setRule(r.id, { style: { ...r.style, width: e.target.value ? Number(e.target.value) : undefined } })} className="w-12 rounded border border-ink-600 bg-ink-850 px-1" />
                  </label>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex gap-2">
        <Btn icon={<Plus size={12} />} onClick={() => add("node")}>Node rule</Btn>
        <Btn icon={<Plus size={12} />} onClick={() => add("rel")}>Relationship rule</Btn>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (c: string | undefined) => void }) {
  return (
    <span className="flex items-center gap-1 text-ink-400">
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? "#ef4444" : undefined)} />
        {label}
      </label>
      {value && <input type="color" value={toHex(value)} onChange={(e) => onChange(e.target.value)} className="h-5 w-7 cursor-pointer border-0 bg-transparent" />}
    </span>
  );
}

function Btn({ children, icon, onClick }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-200 hover:border-accent hover:text-accent">
      {icon}
      {children}
    </button>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c);
  if (m) return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  return "#888888";
}
