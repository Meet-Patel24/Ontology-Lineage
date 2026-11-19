import cytoscape, { type Core, type ElementDefinition, type EventObject, type StylesheetStyle } from "cytoscape";
import dagre from "cytoscape-dagre";
import fcose from "cytoscape-fcose";
import svg from "cytoscape-svg";
import {
  Download,
  EyeOff,
  GitFork,
  Hand,
  Maximize,
  Maximize2,
  Minimize2,
  MousePointer2,
  Network,
  Search,
  Share2,
  Workflow,
  ZoomIn,
  ZoomOut,
  Expand as ExpandIcon,
  Info,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, ViewEdge, ViewNode } from "../api/types";
import { DEFAULT_EDGE_COLOR, PII_RING, START_RING, TRANSFORMATION_COLORS, labelColor, transformationColor } from "../lib/colors";
import { downloadBlob, downloadText, timestampSlug } from "../lib/format";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { PropertiesPanel } from "./PropertiesPanel";

cytoscape.use(dagre);
cytoscape.use(fcose);
cytoscape.use(svg);

export type LayoutKind = "force" | "hierarchical";

interface Props {
  data: GraphData;
  layout?: LayoutKind;
  nodeShape?: "circle" | "box";
  className?: string;
  /** Called on double-click / "Expand"; should merge neighbours into `data`. */
  onExpand?: (node: ViewNode) => Promise<void> | void;
  filenameBase?: string;
  emptyText?: string;
  /** Asset id to use for "Show lineage" / "Impact analysis" (defaults to properties.id). */
  assetIdOf?: (node: ViewNode) => string | undefined;
}

type Selected = { kind: "node"; node: ViewNode } | { kind: "edge"; edge: ViewEdge } | null;

const BG = "#0b0e14";

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function buildStyle(shape: "circle" | "box"): StylesheetStyle[] {
  const box = shape === "box";
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        label: "data(display)",
        "font-family": "Inter, Segoe UI, sans-serif",
        "text-valign": "center",
        "text-halign": "center",
        ...(box
          ? {
              shape: "round-rectangle",
              width: 190,
              height: 46,
              "background-opacity": 0.16,
              "border-width": 2,
              "border-color": "data(color)",
              color: "#e8ecf2",
              "font-size": 11,
              "text-wrap": "wrap",
              "text-max-width": "180px",
            }
          : {
              shape: "ellipse",
              width: 58,
              height: 58,
              "border-width": 2,
              "border-color": "data(border)",
              color: "#0b0e14",
              "font-size": 9,
              "font-weight": 600,
              "text-wrap": "ellipsis",
              "text-max-width": "52px",
            }),
      },
    },
    { selector: "node[?pii]", style: { "border-color": PII_RING, "border-width": 4 } },
    {
      selector: "node[?start]",
      style: { "border-color": START_RING, "border-width": 4, "border-style": "double", "font-weight": 700 },
    },
    {
      selector: "node:selected",
      style: { "overlay-color": "#4f9cf9", "overlay-opacity": 0.28, "overlay-padding": 6 },
    },
    {
      selector: "edge",
      style: {
        width: 1.6,
        "line-color": "data(color)",
        "target-arrow-color": "data(color)",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.9,
        "curve-style": "bezier",
        label: "data(display)",
        "font-size": 8,
        color: "#a6b0c0",
        "text-rotation": "autorotate",
        "text-background-color": BG,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
      },
    },
    { selector: "edge[?thick]", style: { width: 2.6 } },
    {
      selector: "edge:selected",
      style: { width: 3.2, "line-color": "#4f9cf9", "target-arrow-color": "#4f9cf9", color: "#e8ecf2" },
    },
    { selector: ".faded", style: { opacity: 0.14 } },
    { selector: "node.match", style: { "border-color": "#facc15", "border-width": 6 } },
  ];
}

function darken(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.round(v * 0.65));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function toElements(data: GraphData, shape: "circle" | "box", hidden: Set<string>): ElementDefinition[] {
  const nodes = data.nodes.filter((n) => !hidden.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const els: ElementDefinition[] = nodes.map((n) => {
    const color = labelColor(n.label);
    const display =
      shape === "box"
        ? `${truncate(n.caption, 28)}${n.subtitle ? `\n${truncate(String(n.subtitle), 30)}` : ""}`
        : truncate(n.caption, 16);
    return {
      group: "nodes",
      data: { id: n.id, display, color, border: darken(color), pii: !!n.pii, start: !!n.start, label: n.label },
    };
  });
  for (const e of data.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const t = e.properties.transformation;
    els.push({
      group: "edges",
      data: {
        id: `e:${e.id}`,
        source: e.source,
        target: e.target,
        display: e.label,
        color: e.type === "FLOWS_TO" ? transformationColor(t) : DEFAULT_EDGE_COLOR,
        thick: e.type === "FLOWS_TO",
      },
    });
  }
  return els;
}

function layoutOptions(kind: LayoutKind, randomize: boolean, nodeCount: number): cytoscape.LayoutOptions {
  if (kind === "hierarchical") {
    return {
      name: "dagre",
      rankDir: "LR",
      nodeSep: 22,
      rankSep: 110,
      edgeSep: 10,
      fit: true,
      padding: 30,
      animate: false,
    } as unknown as cytoscape.LayoutOptions;
  }
  return {
    name: "fcose",
    quality: nodeCount > 400 ? "draft" : "default",
    randomize,
    animate: false,
    fit: true,
    padding: 30,
    nodeRepulsion: 6500,
    idealEdgeLength: 90,
    nodeSeparation: 80,
  } as unknown as cytoscape.LayoutOptions;
}

export function GraphView({
  data,
  layout: initialLayout = "force",
  nodeShape = "circle",
  className = "h-[480px]",
  onExpand,
  filenameBase = "graph",
  emptyText = "No graph elements to display.",
  assetIdOf = (n) => (typeof n.properties.id === "string" ? n.properties.id : undefined),
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [layout, setLayout] = useState<LayoutKind>(initialLayout);
  const [mode, setMode] = useState<"select" | "pan">("pan");
  const [selected, setSelected] = useState<Selected>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: ViewNode } | null>(null);
  const [search, setSearch] = useState("");
  const [showDownload, setShowDownload] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Fullscreen: Esc exits, and the graph is re-fitted to the new canvas size.
  useEffect(() => {
    const t = setTimeout(() => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.resize();
      cy.fit(undefined, 40);
      if (cy.zoom() > 1.2) {
        cy.zoom(1.2);
        cy.center();
      }
    }, 60);
    if (!fullscreen) return () => clearTimeout(t);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [fullscreen]);
  const navigate = useApp((s) => s.navigate);

  const nodeById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const edgeById = useMemo(() => new Map(data.edges.map((e) => [`e:${e.id}`, e])), [data.edges]);
  const lookups = useRef({ nodeById, edgeById, onExpand });
  lookups.current = { nodeById, edgeById, onExpand };

  useEffect(() => setLayout(initialLayout), [initialLayout]);

  // Drop a selection whose element is no longer part of the graph (e.g. after a level switch).
  useEffect(() => {
    setSelected((s) => {
      if (!s) return s;
      if (s.kind === "node") {
        const n = nodeById.get(s.node.id);
        return n ? { kind: "node", node: n } : null;
      }
      const e = edgeById.get(`e:${s.edge.id}`);
      return e ? { kind: "edge", edge: e } : null;
    });
    setMenu(null);
  }, [nodeById, edgeById]);

  const expand = useCallback(async (node: ViewNode) => {
    const fn = lookups.current.onExpand;
    if (!fn) return;
    anchorRef.current = node.id;
    setExpanding(true);
    try {
      await fn(node);
    } catch (e) {
      toast.error("Expand failed", (e as Error).message);
    } finally {
      setExpanding(false);
    }
  }, []);

  // ---- create cytoscape once -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(nodeShape),
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.05,
      maxZoom: 4,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    // Test hook: lets end-to-end tests find rendered node positions.
    (containerRef.current as HTMLDivElement & { _cy?: Core })._cy = cy;

    cy.on("tap", "node", (ev: EventObject) => {
      const n = lookups.current.nodeById.get(ev.target.id());
      if (n) setSelected({ kind: "node", node: n });
      setMenu(null);
    });
    cy.on("tap", "edge", (ev: EventObject) => {
      const e = lookups.current.edgeById.get(ev.target.id());
      if (e) setSelected({ kind: "edge", edge: e });
      setMenu(null);
    });
    cy.on("tap", (ev: EventObject) => {
      if (ev.target === cy) {
        setSelected(null);
        setMenu(null);
        setShowDownload(false);
      }
    });
    cy.on("dbltap", "node", (ev: EventObject) => {
      const n = lookups.current.nodeById.get(ev.target.id());
      if (n) void expand(n);
    });
    cy.on("cxttap", "node", (ev: EventObject) => {
      const n = lookups.current.nodeById.get(ev.target.id());
      const pos = ev.renderedPosition ?? ev.position;
      if (n) setMenu({ x: pos.x, y: pos.y, node: n });
    });

    const ro = new ResizeObserver(() => cy.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeShape]);

  // ---- sync elements -----------------------------------------------------------
  const runLayout = useCallback(
    (randomize: boolean) => {
      const cy = cyRef.current;
      if (!cy || cy.elements().length === 0) return;
      const l = cy.layout(layoutOptions(layout, randomize, cy.nodes().length));
      // Small graphs should not be blown up to fill the whole canvas.
      l.one("layoutstop", () => {
        if (cy.zoom() > 1.2) {
          cy.zoom(1.2);
          cy.center();
        }
      });
      l.run();
    },
    [layout],
  );

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const els = toElements(data, nodeShape, hidden);
    const wanted = new Set(els.map((e) => e.data.id as string));
    let changed = false;
    cy.batch(() => {
      cy.elements().forEach((el) => {
        if (!wanted.has(el.id())) {
          el.remove();
          changed = true;
        }
      });
      const anchor = anchorRef.current ? cy.getElementById(anchorRef.current) : null;
      const anchorPos = anchor && anchor.nonempty() ? anchor.position() : null;
      const toAdd: ElementDefinition[] = [];
      for (const el of els) {
        const existing = cy.getElementById(el.data.id as string);
        if (existing.nonempty()) existing.data(el.data);
        else {
          if (el.group === "nodes" && anchorPos) {
            el.position = { x: anchorPos.x + (Math.random() - 0.5) * 80, y: anchorPos.y + (Math.random() - 0.5) * 80 };
          }
          toAdd.push(el);
        }
      }
      if (toAdd.length) {
        cy.add(toAdd);
        changed = true;
      }
    });
    if (changed) runLayout(!anchorRef.current);
    anchorRef.current = null;
  }, [data, hidden, nodeShape, runLayout]);

  // Re-layout when the layout kind changes.
  useEffect(() => {
    runLayout(true);
  }, [runLayout]);

  // ---- interaction mode ------------------------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.boxSelectionEnabled(mode === "select");
    cy.userPanningEnabled(mode === "pan");
  }, [mode]);

  // ---- search highlight ------------------------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = search.trim().toLowerCase();
    cy.batch(() => {
      cy.elements().removeClass("faded match");
      if (!q) return;
      const matches = cy.nodes().filter((n) => {
        const v = lookups.current.nodeById.get(n.id());
        if (!v) return false;
        return (
          v.caption.toLowerCase().includes(q) ||
          v.label.toLowerCase().includes(q) ||
          String(v.properties.id ?? "").toLowerCase().includes(q)
        );
      });
      cy.elements().addClass("faded");
      matches.removeClass("faded").addClass("match");
      matches.connectedEdges().removeClass("faded");
    });
  }, [search, data]);

  // ---- actions -----------------------------------------------------------------
  const zoom = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const fit = () => cyRef.current?.fit(undefined, 30);

  const download = (fmt: "png" | "svg" | "json") => {
    const cy = cyRef.current;
    setShowDownload(false);
    if (!cy) return;
    const name = `${filenameBase}-${timestampSlug()}`;
    if (fmt === "png") {
      const blob = cy.png({ output: "blob", full: true, scale: 2, bg: BG }) as unknown as Blob;
      downloadBlob(blob, `${name}.png`);
    } else if (fmt === "svg") {
      const svgText = (cy as unknown as { svg: (o: object) => string }).svg({ full: true, scale: 1, bg: BG });
      downloadText(svgText, `${name}.svg`, "image/svg+xml");
    } else {
      downloadText(JSON.stringify(data, null, 2), `${name}.json`, "application/json");
    }
  };

  const dismiss = (node: ViewNode) => {
    setHidden((h) => new Set([...h, node.id]));
    if (selected?.kind === "node" && selected.node.id === node.id) setSelected(null);
  };

  const legendLabels = useMemo(() => [...new Set(data.nodes.map((n) => n.label))].sort(), [data.nodes]);
  const legendTransformations = useMemo(
    () =>
      [
        ...new Set(
          data.edges
            .filter((e) => e.type === "FLOWS_TO")
            .map((e) => e.properties.transformation)
            .filter((t): t is string => typeof t === "string"),
        ),
      ].sort(),
    [data.edges],
  );
  const hasPii = data.nodes.some((n) => n.pii);

  const empty = data.nodes.length === 0;

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-[70] overflow-hidden bg-ink-950"
          : `relative shrink-0 overflow-hidden rounded-md border border-ink-700 bg-ink-950 ${className}`
      }
    >
      {/* toolbar */}
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-1 rounded-md border border-ink-700 bg-ink-900/95 p-1 shadow-lg">
        <ToolButton title="Pan mode (drag to move the canvas)" active={mode === "pan"} onClick={() => setMode("pan")}>
          <Hand size={15} />
        </ToolButton>
        <ToolButton title="Select mode (drag to box-select)" active={mode === "select"} onClick={() => setMode("select")}>
          <MousePointer2 size={15} />
        </ToolButton>
        <Divider />
        <ToolButton title="Zoom in" onClick={() => zoom(1.25)}>
          <ZoomIn size={15} />
        </ToolButton>
        <ToolButton title="Zoom out" onClick={() => zoom(0.8)}>
          <ZoomOut size={15} />
        </ToolButton>
        <ToolButton title="Fit to screen" onClick={fit}>
          <Maximize size={15} />
        </ToolButton>
        <Divider />
        <ToolButton title="Force layout" active={layout === "force"} onClick={() => setLayout("force")}>
          <Share2 size={15} />
        </ToolButton>
        <ToolButton
          title="Hierarchical layout (left to right)"
          active={layout === "hierarchical"}
          onClick={() => setLayout("hierarchical")}
        >
          <Workflow size={15} />
        </ToolButton>
        <Divider />
        <div className="flex items-center gap-1 rounded bg-ink-850 px-1.5">
          <Search size={13} className="text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search graph"
            className="w-28 bg-transparent py-1 text-xs text-ink-100 outline-none placeholder:text-ink-500"
          />
        </div>
        <div className="relative">
          <ToolButton title="Download" onClick={() => setShowDownload((v) => !v)}>
            <Download size={15} />
          </ToolButton>
          {showDownload && (
            <div className="absolute left-0 top-8 z-20 w-32 rounded-md border border-ink-700 bg-ink-850 py-1 shadow-xl">
              {(["png", "svg", "json"] as const).map((f) => (
                <button
                  key={f}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-ink-700"
                  onClick={() => download(f)}
                >
                  Download {f.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
        <ToolButton
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          active={fullscreen}
          onClick={() => setFullscreen((v) => !v)}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </ToolButton>
        <ToolButton title="Toggle legend" active={showLegend} onClick={() => setShowLegend((v) => !v)}>
          <Info size={15} />
        </ToolButton>
        {hidden.size > 0 && (
          <button
            className="ml-1 rounded px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700"
            onClick={() => setHidden(new Set())}
            title="Show dismissed nodes again"
          >
            Show {hidden.size} hidden
          </button>
        )}
        {expanding && <span className="ml-1 animate-pulse text-[11px] text-accent">expanding…</span>}
      </div>

      <div ref={containerRef} data-graph className="absolute inset-0" onContextMenu={(e) => e.preventDefault()} />

      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-400">
          {emptyText}
        </div>
      )}

      {/* legend */}
      {showLegend && !empty && (
        <div className="absolute bottom-2 left-2 z-10 max-w-[70%] rounded-md border border-ink-700 bg-ink-900/95 px-2 py-1.5 text-[11px] shadow-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {legendLabels.map((l) => (
              <span key={l} className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: labelColor(l) }} />
                {l}
              </span>
            ))}
            {hasPii && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: PII_RING }} />
                PII
              </span>
            )}
          </div>
          {legendTransformations.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-700 pt-1">
              {legendTransformations.map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <span className="inline-block h-0.5 w-4" style={{ background: TRANSFORMATION_COLORS[t] ?? DEFAULT_EDGE_COLOR }} />
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* context menu */}
      {menu && (
        <div
          className="absolute z-30 w-44 rounded-md border border-ink-700 bg-ink-850 py-1 text-xs shadow-xl"
          style={{ left: Math.min(menu.x, (containerRef.current?.clientWidth ?? 400) - 180), top: menu.y }}
        >
          <div className="truncate border-b border-ink-700 px-3 py-1 font-semibold text-ink-300">{menu.node.caption}</div>
          {onExpand && (
            <MenuItem
              icon={<ExpandIcon size={13} />}
              label="Expand"
              onClick={() => {
                setMenu(null);
                void expand(menu.node);
              }}
            />
          )}
          <MenuItem
            icon={<EyeOff size={13} />}
            label="Dismiss"
            onClick={() => {
              setMenu(null);
              dismiss(menu.node);
            }}
          />
          {assetIdOf(menu.node) && (
            <>
              <MenuItem
                icon={<GitFork size={13} />}
                label="Show lineage"
                onClick={() => {
                  setMenu(null);
                  navigate("lineage", { id: assetIdOf(menu.node)! });
                }}
              />
              <MenuItem
                icon={<Network size={13} />}
                label="Impact analysis"
                onClick={() => {
                  setMenu(null);
                  navigate("impact", { id: assetIdOf(menu.node)! });
                }}
              />
            </>
          )}
        </div>
      )}

      {selected && (
        <PropertiesPanel
          selected={selected}
          onClose={() => setSelected(null)}
          nodeById={nodeById}
        />
      )}
    </div>
  );
}

function ToolButton({
  children,
  title,
  onClick,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded p-1.5 transition ${active ? "bg-accent/20 text-accent" : "text-ink-300 hover:bg-ink-700 hover:text-ink-100"}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-ink-700" />;
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-700" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
