import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ENode, ERel } from "./api";
import { DEFAULT_EXPAND_LIMIT, DEFAULT_OVERVIEW_LIMIT, DEFAULT_SEARCH_LIMIT, HARD_MAX_SCENE } from "./constants";

// ---------------------------------------------------------------------------
// Scene contents with undo / redo
// ---------------------------------------------------------------------------

export interface SceneData {
  nodes: Record<string, ENode>;
  rels: Record<string, ERel>;
  hidden: string[];
}

const EMPTY: SceneData = { nodes: {}, rels: {}, hidden: [] };
const MAX_HISTORY = 60;

interface SceneStore extends SceneData {
  name: string;
  pinned: string[];
  past: SceneData[];
  future: SceneData[];
  /** Bumped on every change that should trigger a full re-layout. */
  layoutNonce: number;
  /** Anchor for the last expand: new nodes are placed around it instead of re-laying out. */
  anchor: string | null;
  /** Element ids added by the last operation (briefly highlighted). */
  fresh: string[];
  /** Node ids to select and zoom to once the layout has finished (after a search). */
  focusIds: string[];

  setName: (n: string) => void;
  add: (
    g: { nodes: ENode[]; relationships: ERel[] },
    opts?: { anchor?: string | null; relayout?: boolean; replace?: boolean; focus?: boolean },
  ) => { added: number; skipped: number };
  dismiss: (ids: string[]) => void;
  dismissOthers: (ids: string[]) => void;
  hide: (ids: string[]) => void;
  showAll: () => void;
  clear: () => void;
  togglePin: (ids: string[]) => void;
  undo: () => void;
  redo: () => void;
  load: (data: SceneData & { name?: string; pinned?: string[] }) => void;
  relayout: () => void;
}

function snapshot(s: SceneData): SceneData {
  return { nodes: s.nodes, rels: s.rels, hidden: s.hidden };
}

export const useScene = create<SceneStore>((set, get) => {
  const commit = (next: Partial<SceneData> & Partial<Pick<SceneStore, "layoutNonce" | "anchor" | "fresh" | "pinned" | "focusIds">>) => {
    const s = get();
    set({ ...next, past: [...s.past, snapshot(s)].slice(-MAX_HISTORY), future: [] });
  };
  return {
    ...EMPTY,
    name: "Untitled Scene",
    pinned: [],
    past: [],
    future: [],
    layoutNonce: 0,
    anchor: null,
    fresh: [],
    focusIds: [],

    setName: (name) => set({ name }),

    add: (g, opts = {}) => {
      const s = get();
      const nodes: Record<string, ENode> = opts.replace ? {} : { ...s.nodes };
      let count = Object.keys(nodes).length;
      let added = 0;
      let skipped = 0;
      const fresh: string[] = [];
      for (const n of g.nodes) {
        if (nodes[n.elementId]) {
          nodes[n.elementId] = n; // refresh properties
          continue;
        }
        if (count >= HARD_MAX_SCENE) {
          skipped++;
          continue;
        }
        nodes[n.elementId] = n;
        fresh.push(n.elementId);
        count++;
        added++;
      }
      const rels: Record<string, ERel> = opts.replace ? {} : { ...s.rels };
      for (const r of g.relationships) {
        if (nodes[r.start] && nodes[r.end] && !rels[r.elementId]) {
          rels[r.elementId] = r;
          fresh.push(r.elementId);
        }
      }
      // Re-adding a hidden node makes it visible again.
      const incoming = new Set(g.nodes.map((n) => n.elementId));
      const hidden = opts.replace ? [] : s.hidden.filter((h) => !incoming.has(h));
      const newNodeIds = fresh.filter((id) => nodes[id] && !s.nodes[id]);
      // Select / zoom to the new nodes, or to the results when they were all already in the scene.
      const focusIds = opts.focus ? (newNodeIds.length ? newNodeIds : g.nodes.map((n) => n.elementId).filter((id) => nodes[id])) : [];
      // Nothing new: refresh properties but do not create an undo step or re-layout.
      if (!opts.replace && fresh.length === 0 && hidden.length === s.hidden.length) {
        set({ nodes, rels, fresh: [], focusIds, layoutNonce: focusIds.length ? s.layoutNonce + 1 : s.layoutNonce });
        return { added, skipped };
      }
      commit({
        nodes,
        rels,
        hidden,
        fresh: newNodeIds.concat(fresh.filter((id) => rels[id])),
        focusIds,
        anchor: opts.anchor ?? null,
        layoutNonce: opts.relayout === false ? s.layoutNonce : s.layoutNonce + 1,
      });
      return { added, skipped };
    },

    dismiss: (ids) => {
      const s = get();
      const drop = new Set(ids);
      const nodes = Object.fromEntries(Object.entries(s.nodes).filter(([k]) => !drop.has(k)));
      const rels = Object.fromEntries(
        Object.entries(s.rels).filter(([k, r]) => !drop.has(k) && nodes[r.start] && nodes[r.end]),
      );
      commit({ nodes, rels, hidden: s.hidden.filter((h) => !drop.has(h)), fresh: [], anchor: null });
    },

    dismissOthers: (ids) => {
      const s = get();
      const keep = new Set(ids);
      get().dismiss(Object.keys(s.nodes).filter((k) => !keep.has(k)));
    },

    hide: (ids) => {
      const s = get();
      commit({ hidden: [...new Set([...s.hidden, ...ids])], fresh: [], anchor: null });
    },
    showAll: () => commit({ hidden: [], fresh: [], anchor: null }),
    clear: () => commit({ ...EMPTY, fresh: [], anchor: null, pinned: [] }),
    togglePin: (ids) => {
      const cur = new Set(get().pinned);
      const allPinned = ids.every((i) => cur.has(i));
      ids.forEach((i) => (allPinned ? cur.delete(i) : cur.add(i)));
      set({ pinned: [...cur] });
    },

    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({ ...prev, past: s.past.slice(0, -1), future: [snapshot(s), ...s.future], fresh: [], anchor: null });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ ...next, future: s.future.slice(1), past: [...s.past, snapshot(s)], fresh: [], anchor: null });
    },

    load: (data) =>
      set({
        nodes: data.nodes,
        rels: data.rels,
        hidden: data.hidden ?? [],
        pinned: data.pinned ?? [],
        name: data.name ?? get().name,
        past: [],
        future: [],
        fresh: [],
        focusIds: [],
        anchor: null,
      }),
    relayout: () => set({ layoutNonce: get().layoutNonce + 1, anchor: null }),
  };
});

// ---------------------------------------------------------------------------
// Filters (grey out or hide, never remove)
// ---------------------------------------------------------------------------

export type FilterOp = "eq" | "contains" | "range" | "true" | "false";

export interface FilterCondition {
  id: string;
  kind: "label" | "rel" | "prop";
  /** label / relationship type for `label` and `rel`; for `prop` the target. */
  value: string;
  target?: "node" | "rel";
  property?: string;
  op?: FilterOp;
  operand?: string;
  min?: string;
  max?: string;
}

export interface FilterState {
  enabled: boolean;
  mode: "grey" | "hide";
  conditions: FilterCondition[];
}

interface ViewStore {
  filters: FilterState;
  setFilters: (f: FilterState) => void;
  legendHidden: string[]; // "n:Label" | "r:TYPE"
  toggleLegend: (key: string) => void;
  resetLegend: () => void;
}

export const useView = create<ViewStore>((set, get) => ({
  filters: { enabled: true, mode: "grey", conditions: [] },
  setFilters: (filters) => set({ filters }),
  legendHidden: [],
  toggleLegend: (key) => {
    const cur = get().legendHidden;
    set({ legendHidden: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  },
  resetLegend: () => set({ legendHidden: [] }),
}));

export function propPasses(c: FilterCondition, props: Record<string, unknown>): boolean {
  const v = props[c.property ?? ""];
  switch (c.op) {
    case "eq":
      return v !== undefined && v !== null && String(v).toLowerCase() === (c.operand ?? "").toLowerCase();
    case "contains":
      return v !== undefined && v !== null && String(v).toLowerCase().includes((c.operand ?? "").toLowerCase());
    case "range": {
      const n = Number(v);
      if (v === undefined || v === null || Number.isNaN(n)) return false;
      if (c.min !== undefined && c.min !== "" && n < Number(c.min)) return false;
      if (c.max !== undefined && c.max !== "" && n > Number(c.max)) return false;
      return true;
    }
    case "true":
      return v === true || v === "true";
    case "false":
      return v === false || v === "false";
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Persisted settings: limits and layout
// ---------------------------------------------------------------------------

export type LayoutName = "force" | "dagre-lr" | "dagre-tb" | "circle" | "concentric" | "grid";

export const LAYOUTS: { value: LayoutName; label: string }[] = [
  { value: "force", label: "Force-based layout" },
  { value: "dagre-lr", label: "Hierarchical (left to right)" },
  { value: "dagre-tb", label: "Hierarchical (top down)" },
  { value: "circle", label: "Circular" },
  { value: "concentric", label: "Concentric by degree" },
  { value: "grid", label: "Grid" },
];

export interface LayoutOptions {
  name: LayoutName;
  spacing: number; // multiplier 0.5 .. 3
  edgeLength: number; // px for force layout
  animate: boolean;
}

interface SettingsStore {
  searchLimit: number;
  expandLimit: number;
  overviewLimit: number;
  /** Draw the graph automatically when the Bloom page opens. */
  loadOnOpen: boolean;
  /** Clear the scene before drawing search results (default: add to the scene, like Bloom). */
  searchReplaces: boolean;
  layout: LayoutOptions;
  setLimits: (searchLimit: number, expandLimit: number, overviewLimit?: number) => void;
  setFlags: (f: Partial<Pick<SettingsStore, "loadOnOpen" | "searchReplaces">>) => void;
  setLayout: (l: Partial<LayoutOptions>) => void;
}

export const useBloomSettings = create<SettingsStore>()(
  persist(
    (set, get) => ({
      searchLimit: DEFAULT_SEARCH_LIMIT,
      expandLimit: DEFAULT_EXPAND_LIMIT,
      overviewLimit: DEFAULT_OVERVIEW_LIMIT,
      loadOnOpen: true,
      searchReplaces: false,
      layout: { name: "force", spacing: 1, edgeLength: 120, animate: true },
      setLimits: (searchLimit, expandLimit, overviewLimit) => {
        const clamp = (v: number, d: number) => Math.max(1, Math.min(HARD_MAX_SCENE, Math.round(v) || d));
        set({
          searchLimit: clamp(searchLimit, DEFAULT_SEARCH_LIMIT),
          expandLimit: clamp(expandLimit, DEFAULT_EXPAND_LIMIT),
          overviewLimit: clamp(overviewLimit ?? get().overviewLimit, DEFAULT_OVERVIEW_LIMIT),
        });
      },
      setFlags: (f) => set(f),
      setLayout: (l) => set({ layout: { ...get().layout, ...l } }),
    }),
    {
      name: "lineage-studio.bloom.settings",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // v2: Bloom-like force layout defaults (edge length 120).
      migrate: (state, version) => {
        const s = state as { layout?: LayoutOptions };
        if (version < 2 && s.layout) s.layout = { ...s.layout, edgeLength: 120 };
        return s as never;
      },
    },
  ),
);
