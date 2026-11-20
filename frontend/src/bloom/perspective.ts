import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ENode, ERel, ExploreSchema } from "./api";
import { GENERIC_LABELS } from "./constants";

// Mastek brand palette (primary, secondary and their tints), ordered so neighbours differ in hue.
export const PALETTE = [
  "#0099A8", "#EBAA01", "#AE63E4", "#5ECC62", "#0FBDFF", "#001689", "#EE8A2B", "#E0607E",
  "#2FC4C9", "#F3C64A", "#C99BF0", "#8EDB91", "#5CCFFF", "#3A4FB8", "#F4A261",
];
export const GENERIC_COLOR = "#A9B6CB";
export const DEFAULT_REL_COLOR = "#A0AEC0";
export const DEFAULT_NODE_SIZE = 48;

export interface LabelStyle {
  color: string;
  size: number;
  /** A property name (`name`) or a template (`{table}.{name}`). Empty = label name. */
  caption: string;
  hidden: boolean;
  icon?: string;
}

export interface RelStyle {
  color: string;
  width: number;
  showCaption: boolean;
  hidden: boolean;
}

export type RuleOp = "eq" | "neq" | "contains" | "gt" | "lt" | "true" | "false" | "exists";

export interface StyleRule {
  id: string;
  enabled: boolean;
  target: "node" | "rel";
  /** Label (node) or relationship type (rel); "*" = any. */
  on: string;
  property: string;
  op: RuleOp;
  value: string;
  style: { color?: string; borderColor?: string; size?: number; width?: number };
}

export interface Perspective {
  id: string;
  name: string;
  labels: Record<string, LabelStyle>;
  rels: Record<string, RelStyle>;
  rules: StyleRule[];
  sizeByDegree: boolean;
}

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const CAPTION_PREFERENCE = ["name", "title", "full_name", "id"];

/** Bloom-like default: name, title, full_name, id; text-heavy labels show the first 30 characters of text. */
export function defaultCaption(props: string[]): string {
  const textual = props.includes("text") ? "text" : props.includes("content") ? "content" : null;
  if (textual && !props.includes("name") && !props.includes("title")) return `{${textual}:30}`;
  return CAPTION_PREFERENCE.find((p) => props.includes(p)) ?? "";
}

/** Build a perspective from the discovered schema: one distinct colour per label, sensible captions. */
export function generatePerspective(schema: ExploreSchema, name = "Default Perspective"): Perspective {
  const labels: Record<string, LabelStyle> = {};
  let i = 0;
  for (const l of [...schema.labels].sort((a, b) => a.name.localeCompare(b.name))) {
    const props = (schema.node_properties[l.name] ?? []).map((p) => p.name);
    const generic = GENERIC_LABELS.has(l.name);
    labels[l.name] = {
      color: generic ? GENERIC_COLOR : PALETTE[i++ % PALETTE.length],
      size: DEFAULT_NODE_SIZE,
      caption: defaultCaption(props),
      hidden: false,
    };
  }
  const rels: Record<string, RelStyle> = {};
  for (const t of schema.relationship_types) rels[t.name] = { color: DEFAULT_REL_COLOR, width: 1.2, showCaption: true, hidden: false };

  const rules: StyleRule[] = [];
  if ((schema.node_properties.Column ?? []).some((p) => p.name === "is_pii")) {
    rules.push({ id: uid(), enabled: true, target: "node", on: "Column", property: "is_pii", op: "true", value: "", style: { borderColor: "#ef4444" } });
  }
  if ((schema.relationship_properties.FLOWS_TO ?? []).some((p) => p.name === "transformation")) {
    rules.push({ id: uid(), enabled: true, target: "rel", on: "FLOWS_TO", property: "transformation", op: "eq", value: "MASKED", style: { color: "#ef4444", width: 2.5 } });
  }
  return { id: uid(), name, labels, rels, rules, sizeByDegree: false };
}

// ---------------------------------------------------------------------------
// Style computation
// ---------------------------------------------------------------------------

/** The label a node is styled by: the most specific (least frequent) non-generic label. */
export function styleLabel(node: ENode, counts: Record<string, number>): string {
  const specific = node.labels.filter((l) => !GENERIC_LABELS.has(l));
  const list = specific.length ? specific : node.labels;
  if (list.length <= 1) return list[0] ?? "Node";
  return [...list].sort((a, b) => (counts[a] ?? 1e12) - (counts[b] ?? 1e12) || a.localeCompare(b))[0];
}

/** Template: `name`, `{table}.{name}` or `{text:30}` (first 30 characters). */
export function renderCaption(template: string, props: Record<string, unknown>, fallback: string): string {
  if (!template) return fallback;
  const fmt = (key: string): string => {
    const [k, n] = key.split(":").map((x) => x.trim());
    const v = props[k];
    if (v === undefined || v === null) return "";
    const s = String(v).replace(/\s+/g, " ").trim();
    const max = Number(n);
    return max > 0 && s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
  };
  if (template.includes("{")) {
    const s = template.replace(/\{([^}]+)\}/g, (_m, k: string) => fmt(k));
    return s.replace(/^[.\s]+|[.\s]+$/g, "") || fallback;
  }
  return fmt(template) || fallback;
}

export function ruleMatches(rule: StyleRule, props: Record<string, unknown>): boolean {
  const v = props[rule.property];
  switch (rule.op) {
    case "exists":
      return v !== undefined && v !== null;
    case "true":
      return v === true || v === "true";
    case "false":
      return v === false || v === "false";
    case "eq":
      return v !== undefined && String(v).toLowerCase() === rule.value.toLowerCase();
    case "neq":
      return v === undefined || String(v).toLowerCase() !== rule.value.toLowerCase();
    case "contains":
      return v !== undefined && v !== null && String(v).toLowerCase().includes(rule.value.toLowerCase());
    case "gt":
      return Number(v) > Number(rule.value);
    case "lt":
      return Number(v) < Number(rule.value);
  }
}

export interface NodeVisual {
  label: string;
  color: string;
  border: string;
  borderWidth: number;
  size: number;
  caption: string;
  hidden: boolean;
}

export function nodeVisual(node: ENode, p: Perspective, counts: Record<string, number>, degree: number): NodeVisual {
  const label = styleLabel(node, counts);
  const ls = p.labels[label];
  const color = ls?.color ?? hashColor(label);
  let size = ls?.size ?? DEFAULT_NODE_SIZE;
  if (p.sizeByDegree) size = Math.round(size * (0.7 + Math.min(2.3, Math.sqrt(degree) * 0.35)));
  const v: NodeVisual = {
    label,
    color,
    border: shade(color, 0.6),
    borderWidth: 2,
    size,
    caption: renderCaption(ls?.caption ?? defaultCaption(Object.keys(node.properties)), node.properties, label),
    hidden: !!ls?.hidden,
  };
  for (const r of p.rules) {
    if (!r.enabled || r.target !== "node") continue;
    if (r.on !== "*" && !node.labels.includes(r.on)) continue;
    if (!ruleMatches(r, node.properties)) continue;
    if (r.style.color) v.color = r.style.color;
    if (r.style.borderColor) {
      v.border = r.style.borderColor;
      v.borderWidth = 4;
    }
    if (r.style.size) v.size = r.style.size;
  }
  return v;
}

export interface RelVisual {
  color: string;
  width: number;
  caption: string;
  hidden: boolean;
}

export function relVisual(rel: ERel, p: Perspective): RelVisual {
  const rs = p.rels[rel.type];
  const v: RelVisual = {
    color: rs?.color ?? DEFAULT_REL_COLOR,
    width: rs?.width ?? 1.2,
    caption: rs?.showCaption === false ? "" : rel.type,
    hidden: !!rs?.hidden,
  };
  for (const r of p.rules) {
    if (!r.enabled || r.target !== "rel") continue;
    if (r.on !== "*" && r.on !== rel.type) continue;
    if (!ruleMatches(r, rel.properties)) continue;
    if (r.style.color) v.color = r.style.color;
    if (r.style.width) v.width = r.style.width;
  }
  return v;
}

function shade(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (x: number) => Math.round(x * f);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

// ---------------------------------------------------------------------------
// Store (localStorage)
// ---------------------------------------------------------------------------

interface PerspectiveStore {
  perspectives: Perspective[];
  activeId: string | null;
  active: () => Perspective | null;
  ensureDefault: (schema: ExploreSchema) => void;
  setActive: (id: string) => void;
  update: (id: string, fn: (p: Perspective) => Perspective) => void;
  add: (p: Perspective) => void;
  remove: (id: string) => void;
}

export const usePerspectives = create<PerspectiveStore>()(
  persist(
    (set, get) => ({
      perspectives: [],
      activeId: null,
      active: () => get().perspectives.find((p) => p.id === get().activeId) ?? get().perspectives[0] ?? null,
      ensureDefault: (schema) => {
        if (!get().perspectives.some((p) => p.name === "Default Perspective")) {
          const p = generatePerspective(schema);
          set({ perspectives: [p, ...get().perspectives], activeId: get().activeId ?? p.id });
        }
      },
      setActive: (activeId) => set({ activeId }),
      update: (id, fn) => set({ perspectives: get().perspectives.map((p) => (p.id === id ? fn(p) : p)) }),
      add: (p) => set({ perspectives: [...get().perspectives, p], activeId: p.id }),
      remove: (id) => {
        const rest = get().perspectives.filter((p) => p.id !== id);
        set({ perspectives: rest, activeId: rest[0]?.id ?? null });
      },
    }),
    {
      name: "lineage-studio.bloom.perspectives",
      storage: createJSONStorage(() => localStorage),
      version: 3,
      // v2: Bloom-like defaults (captions inside 48 px circles, grey relationships).
      // v3: Mastek brand palette. Old auto-generated perspectives are regenerated from the schema;
      // user-created ones are kept.
      migrate: (state, version) => {
        const s = state as { perspectives?: Perspective[]; activeId?: string | null };
        if (version < 3) {
          const kept = (s.perspectives ?? []).filter((p) => p.name !== "Default Perspective");
          return { perspectives: kept, activeId: kept[0]?.id ?? null } as never;
        }
        return s as never;
      },
    },
  ),
);
