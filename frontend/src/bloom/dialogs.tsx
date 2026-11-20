import { Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { timeAgo } from "../lib/format";
import { toast } from "../store/toasts";
import { type ExploreSchema, type Phrase, type PhraseInput, exploreApi } from "./api";
import { type SavedScene, useSavedScenes } from "./savedScenes";
import { type FilterCondition, type FilterOp, LAYOUTS, useBloomSettings, useView } from "./sceneStore";
import { uid } from "./perspective";

export function Modal({ title, children, onClose, width = "w-[640px]" }: { title: string; children: React.ReactNode; onClose: () => void; width?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#001689]/30" onMouseDown={onClose}>
      <div className={`${width} flex max-h-[86vh] max-w-[94vw] flex-col rounded-lg border border-ink-600 bg-ink-900 shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-100">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-xs">{children}</div>
      </div>
    </div>
  );
}

const input = "rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 outline-none focus:border-accent";

// ---------------------------------------------------------------------------
// Search phrases
// ---------------------------------------------------------------------------

const EMPTY_PHRASE: PhraseInput = { name: "", description: "", cypher: "", params: [] };

export function PhraseManager({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Phrase[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; data: PhraseInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => exploreApi.phrases().then(setList).catch((e) => toast.error("Could not load phrases", (e as Error).message));
  useEffect(() => void load(), []);

  const save = async () => {
    if (!editing) return;
    setError(null);
    // keep params in sync with $names in the phrase name
    const names = [...editing.data.name.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]);
    const params = names.map((n) => editing.data.params.find((p) => p.name === n) ?? { name: n, source: null });
    try {
      const body = { ...editing.data, params };
      if (editing.id) await exploreApi.updatePhrase(editing.id, body);
      else await exploreApi.createPhrase(body);
      toast.success("Phrase saved");
      setEditing(null);
      void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <Modal title="Search phrases" onClose={onClose} width="w-[760px]">
      {editing ? (
        <div className="space-y-2">
          <Field label="Name (use $param for parameters, e.g. Lineage of $column)">
            <input className={`${input} w-full`} value={editing.data.name} onChange={(e) => setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })} />
          </Field>
          <Field label="Description">
            <input className={`${input} w-full`} value={editing.data.description} onChange={(e) => setEditing({ ...editing, data: { ...editing.data, description: e.target.value } })} />
          </Field>
          <Field label="Cypher (read-only; parameters as $name)">
            <textarea
              rows={9}
              spellCheck={false}
              className={`${input} w-full font-mono`}
              value={editing.data.cypher}
              onChange={(e) => setEditing({ ...editing, data: { ...editing.data, cypher: e.target.value } })}
            />
          </Field>
          {[...editing.data.name.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => {
            const name = m[1];
            const cur = editing.data.params.find((p) => p.name === name);
            return (
              <Field key={name} label={`$${name}: value suggestions from (Label.property, optional)`}>
                <input
                  className={`${input} w-64 font-mono`}
                  placeholder="Column.name"
                  value={cur?.source ?? ""}
                  onChange={(e) => {
                    const others = editing.data.params.filter((p) => p.name !== name);
                    setEditing({ ...editing, data: { ...editing.data, params: [...others, { name, source: e.target.value || null }] } });
                  }}
                />
              </Field>
            );
          })}
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-800">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setEditing(null)} className="rounded px-3 py-1 text-ink-300 hover:bg-ink-700">
              Cancel
            </button>
            <button onClick={() => void save()} className="rounded bg-accent px-3 py-1 font-semibold text-white">
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex justify-between">
            <p className="text-ink-400">Phrases appear in the search suggestions when the typed text matches their name.</p>
            <button onClick={() => setEditing({ id: null, data: EMPTY_PHRASE })} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 hover:border-accent hover:text-accent">
              <Plus size={12} /> New phrase
            </button>
          </div>
          {list === null && <div className="text-ink-400">Loading…</div>}
          {list?.map((p) => (
            <div key={p.id} className="rounded border border-ink-700 p-2">
              <div className="flex items-center gap-2">
                <span className="rounded bg-violet-300 px-2 py-0.5 font-semibold text-[#111827]">{p.name}</span>
                <span className="flex-1 truncate text-ink-400">{p.description}</span>
                <button
                  title="Edit"
                  onClick={() => setEditing({ id: p.id, data: { name: p.name, description: p.description, cypher: p.cypher, params: p.params } })}
                  className="rounded p-1 text-ink-400 hover:text-ink-100"
                >
                  <Pencil size={13} />
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    if (!window.confirm(`Delete phrase "${p.name}"?`)) return;
                    await exploreApi.deletePhrase(p.id).catch((e) => toast.error("Delete failed", (e as Error).message));
                    void load();
                  }}
                  className="rounded p-1 text-ink-400 hover:text-red-700"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-1.5 font-mono text-[10px] text-ink-300">{p.cypher}</pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-400">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Open scene
// ---------------------------------------------------------------------------

export function OpenSceneDialog({ onOpen, onImport, onClose }: { onOpen: (s: SavedScene) => void; onImport: (f: File) => void; onClose: () => void }) {
  const { scenes, rename, remove } = useSavedScenes();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Modal title="Open scene" onClose={onClose}>
      <div className="mb-3 flex justify-end">
        <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 hover:border-accent hover:text-accent">
          <Upload size={12} /> Import scene JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </div>
      {scenes.length === 0 && <div className="rounded border border-dashed border-ink-700 p-4 text-center text-ink-400">No saved scenes yet. Use Export → Save scene.</div>}
      <div className="space-y-1.5">
        {scenes.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded border border-ink-700 px-3 py-2 hover:border-ink-500">
            <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(s)}>
              <div className="truncate font-semibold text-ink-100">{s.name}</div>
              <div className="text-[10px] text-ink-400">
                {Object.keys(s.nodes).length} nodes · {Object.keys(s.rels).length} relationships · saved {timeAgo(s.savedAt)}
              </div>
            </button>
            <button
              title="Rename"
              onClick={() => {
                const n = window.prompt("Rename scene", s.name);
                if (n?.trim()) rename(s.id, n.trim());
              }}
              className="rounded p-1 text-ink-400 hover:text-ink-100"
            >
              <Pencil size={13} />
            </button>
            <button title="Delete" onClick={() => window.confirm(`Delete scene "${s.name}"?`) && remove(s.id)} className="rounded p-1 text-ink-400 hover:text-red-700">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsDialog({ schema, onRefreshSchema, onClose }: { schema: ExploreSchema | null; onRefreshSchema: () => void; onClose: () => void }) {
  const s = useBloomSettings();
  const [search, setSearch] = useState(String(s.searchLimit));
  const [expand, setExpand] = useState(String(s.expandLimit));
  const [overview, setOverview] = useState(String(s.overviewLimit));
  const [loadOnOpen, setLoadOnOpen] = useState(s.loadOnOpen);
  const [replaces, setReplaces] = useState(s.searchReplaces);
  return (
    <Modal title="Bloom settings" onClose={onClose} width="w-[460px]">
      <div className="space-y-3">
        <Field label="Max nodes per search (1 - 2000)">
          <input className={`${input} w-32`} type="number" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Max nodes per expand (1 - 2000)">
          <input className={`${input} w-32`} type="number" value={expand} onChange={(e) => setExpand(e.target.value)} />
        </Field>
        <Field label="Overview limit: nodes drawn by 'Show whole graph' (1 - 2000)">
          <input className={`${input} w-32`} type="number" value={overview} onChange={(e) => setOverview(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={loadOnOpen} onChange={(e) => setLoadOnOpen(e.target.checked)} /> Load graph on open
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={replaces} onChange={(e) => setReplaces(e.target.checked)} /> Search replaces scene (off: results are added, like Bloom)
        </label>
        <p className="text-ink-400">The scene holds at most 2,000 nodes. Captions hide automatically below 60% zoom and above 1,500 elements.</p>
        <div className="flex items-center justify-between rounded border border-ink-700 p-2">
          <div>
            <div className="font-semibold">Schema</div>
            <div className="text-[11px] text-ink-400">
              {schema ? `${schema.labels.length} labels, ${schema.relationship_types.length} relationship types · discovered ${timeAgo(schema.discovered_at * 1000)}` : "not loaded"}
            </div>
          </div>
          <button onClick={onRefreshSchema} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 hover:border-accent hover:text-accent">
            <RefreshCw size={12} /> Refresh schema
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => {
              s.setLimits(Number(search), Number(expand), Number(overview));
              s.setFlags({ loadOnOpen, searchReplaces: replaces });
              toast.success("Settings saved");
              onClose();
            }}
            className="rounded bg-accent px-3 py-1 font-semibold text-white"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Layout options popover
// ---------------------------------------------------------------------------

export function LayoutOptionsPopover({ onClose }: { onClose: () => void }) {
  const { layout, setLayout } = useBloomSettings();
  return (
    <div className="absolute bottom-14 right-0 z-40 w-72 rounded-lg border border-ink-600 bg-ink-900 p-3 text-xs shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Layout options</span>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-100">
          <X size={14} />
        </button>
      </div>
      <label className="mb-2 block">
        <span className="text-ink-400">Spacing ×{layout.spacing.toFixed(1)}</span>
        <input type="range" min={0.5} max={3} step={0.1} value={layout.spacing} onChange={(e) => setLayout({ spacing: Number(e.target.value) })} className="w-full" />
      </label>
      <label className="mb-2 block">
        <span className="text-ink-400">Edge length {layout.edgeLength}px (force layout)</span>
        <input type="range" min={30} max={300} step={10} value={layout.edgeLength} onChange={(e) => setLayout({ edgeLength: Number(e.target.value) })} className="w-full" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={layout.animate} onChange={(e) => setLayout({ animate: e.target.checked })} /> Animate
      </label>
      <p className="mt-2 text-[10px] text-ink-500">{LAYOUTS.find((l) => l.value === layout.name)?.label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function FilterPanel({ schema, onClose }: { schema: ExploreSchema | null; onClose: () => void }) {
  const { filters, setFilters } = useView();
  const update = (id: string, patch: Partial<FilterCondition>) =>
    setFilters({ ...filters, conditions: filters.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const add = (kind: FilterCondition["kind"]) =>
    setFilters({
      ...filters,
      conditions: [...filters.conditions, { id: uid(), kind, value: kind === "prop" ? "*" : "", target: "node", op: "eq", operand: "" }],
    });
  const labels = schema?.labels.map((l) => l.name) ?? [];
  const types = schema?.relationship_types.map((t) => t.name) ?? [];

  return (
    <div className="absolute left-0 top-12 z-40 w-[440px] rounded-lg border border-ink-600 bg-ink-900/[0.98] p-3 text-xs shadow-2xl">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">Filter scene</span>
        <label className="ml-2 flex items-center gap-1 text-ink-300">
          <input type="checkbox" checked={filters.enabled} onChange={(e) => setFilters({ ...filters, enabled: e.target.checked })} /> enabled
        </label>
        <select value={filters.mode} onChange={(e) => setFilters({ ...filters, mode: e.target.value as "grey" | "hide" })} className={input}>
          <option value="grey">grey out</option>
          <option value="hide">hide</option>
        </select>
        <button onClick={onClose} className="ml-auto text-ink-400 hover:text-ink-100">
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-[11px] text-ink-400">Elements that do not match all conditions (AND) are greyed out or hidden; nothing is removed from the scene.</p>
      <div className="space-y-1.5">
        {filters.conditions.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-1 rounded border border-ink-700 p-1.5">
            {c.kind === "label" && (
              <>
                <span className="text-ink-400">Node label is</span>
                <select value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} className={input}>
                  <option value="">choose…</option>
                  {labels.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </>
            )}
            {c.kind === "rel" && (
              <>
                <span className="text-ink-400">Relationship type is</span>
                <select value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} className={input}>
                  <option value="">choose…</option>
                  {types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </>
            )}
            {c.kind === "prop" && (
              <>
                <select value={c.target} onChange={(e) => update(c.id, { target: e.target.value as "node" | "rel", value: "*" })} className={input}>
                  <option value="node">Node</option>
                  <option value="rel">Relationship</option>
                </select>
                <select value={c.value} onChange={(e) => update(c.id, { value: e.target.value })} className={input}>
                  <option value="*">any</option>
                  {(c.target === "rel" ? types : labels).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <input
                  list={`fp-${c.id}`}
                  value={c.property ?? ""}
                  onChange={(e) => update(c.id, { property: e.target.value })}
                  placeholder="property"
                  className={`${input} w-24 font-mono`}
                />
                <datalist id={`fp-${c.id}`}>
                  {[
                    ...new Set(
                      (c.target === "rel"
                        ? c.value === "*" ? Object.values(schema?.relationship_properties ?? {}).flat() : schema?.relationship_properties[c.value] ?? []
                        : c.value === "*" ? Object.values(schema?.node_properties ?? {}).flat() : schema?.node_properties[c.value] ?? []
                      ).map((p) => p.name),
                    ),
                  ].map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <select value={c.op} onChange={(e) => update(c.id, { op: e.target.value as FilterOp })} className={input}>
                  <option value="eq">equals</option>
                  <option value="contains">contains</option>
                  <option value="range">between</option>
                  <option value="true">is true</option>
                  <option value="false">is false</option>
                </select>
                {(c.op === "eq" || c.op === "contains") && (
                  <input value={c.operand ?? ""} onChange={(e) => update(c.id, { operand: e.target.value })} placeholder="value" className={`${input} w-24`} />
                )}
                {c.op === "range" && (
                  <>
                    <input value={c.min ?? ""} onChange={(e) => update(c.id, { min: e.target.value })} placeholder="min" className={`${input} w-14`} />
                    <input value={c.max ?? ""} onChange={(e) => update(c.id, { max: e.target.value })} placeholder="max" className={`${input} w-14`} />
                  </>
                )}
              </>
            )}
            <button
              onClick={() => setFilters({ ...filters, conditions: filters.conditions.filter((x) => x.id !== c.id) })}
              className="ml-auto text-ink-400 hover:text-red-700"
              title="Remove"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(["label", "rel", "prop"] as const).map((k) => (
          <button key={k} onClick={() => add(k)} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-0.5 hover:border-accent hover:text-accent">
            <Plus size={11} /> {k === "label" ? "Label" : k === "rel" ? "Relationship type" : "Property"}
          </button>
        ))}
        {filters.conditions.length > 0 && (
          <button onClick={() => setFilters({ ...filters, conditions: [] })} className="ml-auto rounded px-2 py-0.5 text-ink-400 hover:text-ink-100">
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
