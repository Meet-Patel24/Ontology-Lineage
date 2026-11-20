import cytoscape, { type Core, type ElementDefinition, type EventObject, type NodeSingular } from "cytoscape";
import dagre from "cytoscape-dagre";
import fcose from "cytoscape-fcose";
import svg from "cytoscape-svg";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { LABEL_HIDE_ELEMENTS, LABEL_HIDE_ZOOM } from "./constants";
import { type Perspective, nodeVisual, relVisual } from "./perspective";
import { type LayoutOptions, useBloomSettings, useScene, useView } from "./sceneStore";
import type { Visibility } from "./visibility";

// Registering twice throws in some versions; guard it.
const reg = cytoscape as unknown as { __bloomRegistered?: boolean };
if (!reg.__bloomRegistered) {
  try {
    cytoscape.use(dagre);
    cytoscape.use(fcose);
    cytoscape.use(svg);
  } catch {
    /* already registered by GraphView */
  }
  reg.__bloomRegistered = true;
}

export const CANVAS_BG = "#ffffff";

export interface ContextTarget {
  kind: "node" | "rel" | "canvas";
  id?: string;
  x: number;
  y: number;
}

export interface BloomCanvasHandle {
  cy: () => Core | null;
  fit: () => void;
  zoomBy: (f: number) => void;
  runLayout: () => void;
  centerOn: (id: string) => void;
  select: (ids: string[]) => void;
  selectAll: () => void;
  clearSelection: () => void;
  selectedNodeIds: () => string[];
  positions: () => Record<string, { x: number; y: number }>;
  setPositions: (p: Record<string, { x: number; y: number }>) => void;
  viewport: () => { zoom: number; pan: { x: number; y: number } };
  setViewport: (v: { zoom: number; pan: { x: number; y: number } }) => void;
  png: (transparent: boolean) => Blob | null;
  svg: () => string | null;
}

interface Props {
  perspective: Perspective | null;
  counts: Record<string, number>;
  visibility: Visibility;
  onSelection: (sel: { nodes: string[]; rels: string[] }) => void;
  onExpand: (id: string) => void;
  onContext: (t: ContextTarget) => void;
  onZoom: (z: number) => void;
}

const STYLE: cytoscape.StylesheetStyle[] = [
  {
    selector: "node",
    style: {
      width: "data(size)",
      height: "data(size)",
      "background-color": "data(color)",
      "border-width": "data(bw)",
      "border-color": "data(border)",
      label: "data(caption)",
      color: "data(textColor)",
      "font-size": 8,
      "font-weight": 600,
      "font-family": "Inter, Segoe UI, sans-serif",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "text-max-width": "200px",
      "line-height": 1.15,
      "min-zoomed-font-size": 5,
    },
  },
  {
    selector: "edge",
    style: {
      width: "data(width)",
      "line-color": "data(color)",
      "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.7,
      "curve-style": "bezier", // parallel relationships between the same nodes are drawn curved
      label: "data(caption)",
      "font-size": 7,
      color: "#4B5563",
      "text-rotation": "autorotate",
      "text-background-color": CANVAS_BG,
      "text-background-opacity": 0.9,
      "text-background-padding": "1px",
      "min-zoomed-font-size": 5,
    },
  },
  { selector: ".nolabel", style: { label: "" } },
  { selector: "node:selected", style: { "border-width": 6, "border-color": "#001689", "overlay-opacity": 0 } },
  { selector: "edge:selected", style: { "line-color": "#001689", "target-arrow-color": "#001689", width: 2.5 } },
  { selector: "node.locked", style: { "border-style": "dashed" } },
  { selector: ".faded", style: { opacity: 0.15 } },
  { selector: ".grey", style: { opacity: 0.12 } },
  { selector: ".gone", style: { display: "none" } },
  { selector: "node.fresh", style: { "overlay-color": "#EBAA01", "overlay-opacity": 0.3, "overlay-padding": 8 } },
  { selector: "edge.fresh", style: { "line-color": "#EBAA01", "target-arrow-color": "#EBAA01" } },
  { selector: "node.flash", style: { "overlay-color": "#EBAA01", "overlay-opacity": 0.5, "overlay-padding": 12 } },
];

/** Wrap a caption to at most two short lines with an ellipsis, so it fits inside the circle. */
export function wrapCaption(text: string, size: number): string {
  const perLine = Math.max(5, Math.floor(size / 4.6));
  const words = text.replace(/[_.]/g, (m) => `${m}​`).split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    for (const piece of w.split("​")) {
      if ((cur + piece).length <= perLine) cur += piece;
      else {
        if (cur) lines.push(cur);
        cur = piece;
        while (cur.length > perLine) {
          lines.push(cur.slice(0, perLine));
          cur = cur.slice(perLine);
        }
      }
    }
    if (cur && !cur.endsWith(" ")) cur += " ";
  }
  if (cur.trim()) lines.push(cur);
  const out = lines.map((l) => l.trim()).filter(Boolean);
  if (out.length <= 2) return out.join("\n");
  return `${out[0]}\n${out[1].slice(0, perLine - 1)}…`;
}

/** Dark text on light colours, white text on dark colours. */
export function textColorFor(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg);
  let r = 128,
    g = 128,
    b = 128;
  if (m) {
    const n = parseInt(m[1], 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    if (rgb) [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? "#111418" : "#ffffff";
}

export function layoutConfig(
  o: LayoutOptions,
  randomize: boolean,
  fixed?: { nodeId: string; position: { x: number; y: number } }[],
): cytoscape.LayoutOptions {
  const s = o.spacing;
  const common = { animate: o.animate, animationDuration: 450, fit: !fixed, padding: 50 };
  switch (o.name) {
    case "dagre-lr":
    case "dagre-tb":
      return { name: "dagre", rankDir: o.name === "dagre-lr" ? "LR" : "TB", nodeSep: 30 * s, rankSep: 100 * s, edgeSep: 10, ...common } as unknown as cytoscape.LayoutOptions;
    case "circle":
      return { name: "circle", spacingFactor: s, ...common } as cytoscape.LayoutOptions;
    case "concentric":
      return {
        name: "concentric",
        concentric: (n: NodeSingular) => n.degree(false),
        levelWidth: () => 2,
        minNodeSpacing: 20 * s,
        ...common,
      } as unknown as cytoscape.LayoutOptions;
    case "grid":
      return { name: "grid", spacingFactor: s, avoidOverlap: true, ...common } as cytoscape.LayoutOptions;
    default:
      // Bloom-like force layout
      return {
        name: "fcose",
        quality: "default",
        randomize,
        nodeRepulsion: 8000 * s,
        idealEdgeLength: o.edgeLength * s,
        nodeSeparation: 75 * s,
        gravity: 0.25,
        gravityRange: 3.8,
        numIter: 2500,
        ...(fixed && fixed.length ? { fixedNodeConstraint: fixed } : {}),
        ...common,
      } as unknown as cytoscape.LayoutOptions;
  }
}

export const BloomCanvas = forwardRef<BloomCanvasHandle, Props>(function BloomCanvas(
  { perspective, counts, visibility, onSelection, onExpand, onContext, onZoom },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const posCache = useRef(new Map<string, { x: number; y: number }>());
  const lastLayout = useRef(-1);
  const labelsHidden = useRef<boolean | null>(null);
  const cbs = useRef({ onSelection, onExpand, onContext, onZoom });
  cbs.current = { onSelection, onExpand, onContext, onZoom };
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  const scene = useScene();
  const layout = useBloomSettings((s) => s.layout);
  useView(); // re-render on filter / legend changes (visibility is computed by the parent)

  /** Hide captions when zoomed out or when the scene is very large (like Bloom). */
  const updateLabels = (force = false) => {
    const cy = cyRef.current;
    if (!cy) return;
    const hide = cy.zoom() < LABEL_HIDE_ZOOM || cy.elements().length > LABEL_HIDE_ELEMENTS;
    if (!force && hide === labelsHidden.current) return;
    labelsHidden.current = hide;
    cy.batch(() => cy.elements().toggleClass("nolabel", hide));
  };

  /** Selected nodes and their neighbours stay bright, everything else fades. */
  const updateFocus = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const sel = cy.$(":selected");
    cy.batch(() => {
      if (sel.empty()) {
        cy.elements().removeClass("faded");
        return;
      }
      const keep = sel.nodes().closedNeighborhood().union(sel.edges().connectedNodes()).union(sel);
      cy.elements().addClass("faded");
      keep.removeClass("faded");
    });
  };

  const focusOn = (ids: string[]) => {
    const cy = cyRef.current;
    if (!cy || !ids.length) return;
    const col = cy.collection();
    ids.forEach((id) => col.merge(cy.getElementById(id)));
    const nodes = col.nodes().not(".gone");
    if (nodes.empty()) return;
    cy.batch(() => {
      cy.$(":selected").unselect();
      nodes.select();
    });
    cy.animate({ fit: { eles: nodes, padding: 90 } }, { duration: 400, complete: () => cy.zoom() > 1.6 && cy.animate({ zoom: 1.6, center: { eles: nodes } }, { duration: 200 }) });
  };

  const runLayout = (randomize = false, fixedIds?: Set<string>, then?: () => void) => {
    const cy = cyRef.current;
    if (!cy) return;
    const eles = cy.elements().not(".gone");
    if (eles.empty()) return;
    const fixed = fixedIds
      ? eles
          .nodes()
          .filter((n) => fixedIds.has(n.id()))
          .map((n) => ({ nodeId: n.id(), position: { ...(n as NodeSingular).position() } }))
      : undefined;
    const l = eles.layout(layoutConfig(useBloomSettings.getState().layout, randomize, fixed));
    if (then) l.one("layoutstop", then);
    l.run();
  };

  // ---- create once ----------------------------------------------------------------
  useEffect(() => {
    if (!hostRef.current) return;
    const cy = cytoscape({
      container: hostRef.current,
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.03,
      maxZoom: 5,
      boxSelectionEnabled: true, // shift/ctrl + drag on the background
      selectionType: "single", // shift/ctrl + click adds to the selection
      textureOnViewport: true,
    });
    cyRef.current = cy;
    (hostRef.current as HTMLDivElement & { _cy?: Core })._cy = cy;

    let raf = 0;
    const emitSelection = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        updateFocus();
        const sel = cy.$(":selected");
        cbs.current.onSelection({ nodes: sel.nodes().map((n) => n.id()), rels: sel.edges().map((e) => e.id()) });
      });
    };
    cy.on("select unselect", emitSelection);
    cy.on("dbltap", "node", (e: EventObject) => cbs.current.onExpand(e.target.id()));
    cy.on("cxttap", (e: EventObject) => {
      const pos = e.renderedPosition ?? { x: 0, y: 0 };
      if (e.target === cy) {
        cbs.current.onContext({ kind: "canvas", x: pos.x, y: pos.y });
        return;
      }
      const t = e.target;
      if (!t.selected()) {
        cy.$(":selected").unselect();
        t.select();
      }
      cbs.current.onContext({ kind: t.isNode() ? "node" : "rel", id: t.id(), x: pos.x, y: pos.y });
    });
    cy.on("zoom", () => {
      cbs.current.onZoom(cy.zoom());
      updateLabels();
    });
    cy.on("mouseover", "node, edge", (e: EventObject) => {
      const t = e.target;
      const pos = e.renderedPosition ?? { x: 0, y: 0 };
      const d = t.data();
      setTip({ x: pos.x, y: pos.y, title: d.tipTitle, lines: d.tipLines ?? [] });
    });
    cy.on("mouseout", "node, edge", () => setTip(null));
    cy.on("drag pan zoom", () => setTip(null));

    const ro = new ResizeObserver(() => cy.resize());
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- sync scene -> cytoscape (batched) -----------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const p = perspective;
    const degree = new Map<string, number>();
    for (const r of Object.values(scene.rels)) {
      degree.set(r.start, (degree.get(r.start) ?? 0) + 1);
      degree.set(r.end, (degree.get(r.end) ?? 0) + 1);
    }
    const wasEmpty = cy.nodes().empty();
    const before = new Set(cy.nodes().map((n) => n.id()));
    const anchor = scene.anchor ? cy.getElementById(scene.anchor) : null;
    const anchorPos = anchor && anchor.nonempty() ? { ...anchor.position() } : null;
    const extent = cy.extent();
    const center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
    const freshSet = new Set(scene.fresh);
    const newNodes: string[] = [];

    cy.batch(() => {
      // remove
      cy.elements().forEach((el) => {
        const id = el.id();
        if (el.isNode() ? !scene.nodes[id] : !scene.rels[id]) {
          if (el.isNode()) posCache.current.set(id, { ...el.position() });
          el.remove();
        }
      });
      // nodes
      const toAdd: ElementDefinition[] = [];
      for (const n of Object.values(scene.nodes)) {
        const v = p ? nodeVisual(n, p, counts, degree.get(n.elementId) ?? 0) : null;
        const color = v?.color ?? "#888";
        const size = v?.size ?? 48;
        const caption = v?.caption ?? n.labels[0];
        const label = visibility.styleLabels.get(n.elementId) ?? n.labels[0];
        const data = {
          id: n.elementId,
          color,
          textColor: textColorFor(color),
          border: v?.border ?? "#555",
          bw: v?.borderWidth ?? 2,
          size,
          caption: wrapCaption(caption, size),
          tipTitle: `${label}: ${caption}`,
          tipLines: n.labels.length > 1 ? [`Labels: ${n.labels.join(", ")}`] : [],
        };
        const el = cy.getElementById(n.elementId);
        if (el.nonempty()) el.data(data);
        else {
          let position = posCache.current.get(n.elementId);
          if (!position) position = { x: center.x + (Math.random() - 0.5) * 240, y: center.y + (Math.random() - 0.5) * 240 };
          toAdd.push({ group: "nodes", data, position });
          newNodes.push(n.elementId);
        }
      }
      // place expanded nodes on a ring around the node they came from
      if (anchorPos && newNodes.length) {
        const r = 110 + newNodes.length * 5;
        toAdd.forEach((el, i) => {
          if (posCache.current.has(el.data.id as string)) return;
          const a = (2 * Math.PI * i) / newNodes.length;
          el.position = { x: anchorPos.x + r * Math.cos(a), y: anchorPos.y + r * Math.sin(a) };
        });
      }
      if (toAdd.length) cy.add(toAdd);
      // relationships
      const relAdd: ElementDefinition[] = [];
      for (const r of Object.values(scene.rels)) {
        const v = p ? relVisual(r, p) : null;
        const keyProps = Object.entries(r.properties)
          .filter(([, val]) => typeof val !== "object")
          .slice(0, 5)
          .map(([k, val]) => `${k}: ${String(val).slice(0, 80)}`);
        const data = {
          id: r.elementId,
          source: r.start,
          target: r.end,
          color: v?.color ?? "#8a93a3",
          width: v?.width ?? 1.2,
          caption: v?.caption ?? r.type,
          tipTitle: `:${r.type}`,
          tipLines: keyProps,
        };
        const el = cy.getElementById(r.elementId);
        if (el.nonempty()) el.data(data);
        else relAdd.push({ group: "edges", data });
      }
      if (relAdd.length) cy.add(relAdd);

      // visibility classes and pins
      const pinned = new Set(scene.pinned);
      cy.nodes().forEach((n) => {
        const st = visibility.nodes.get(n.id()) ?? "show";
        n.toggleClass("gone", st === "gone");
        n.toggleClass("grey", st === "grey");
        const pin = pinned.has(n.id());
        n.toggleClass("locked", pin);
        if (pin) n.lock();
        else n.unlock();
      });
      cy.edges().forEach((e) => {
        const st = visibility.rels.get(e.id()) ?? "show";
        e.toggleClass("gone", st === "gone");
        e.toggleClass("grey", st === "grey");
      });
    });
    updateLabels(true);
    updateFocus();

    // briefly highlight what was just added
    if (freshSet.size) {
      const fresh = cy.collection();
      freshSet.forEach((id) => fresh.merge(cy.getElementById(id)));
      fresh.addClass("fresh");
      setTimeout(() => fresh.removeClass("fresh"), 1600);
    }

    if (scene.layoutNonce !== lastLayout.current) {
      lastLayout.current = scene.layoutNonce;
      const focus = scene.focusIds;
      const after = focus.length ? () => focusOn(focus) : undefined;
      if (wasEmpty) runLayout(true, undefined, after);
      else if (newNodes.length) runLayout(false, before, after); // incremental: existing nodes keep their positions
      else if (focus.length) focusOn(focus);
      else runLayout(false); // explicit re-layout
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.nodes, scene.rels, scene.pinned, scene.layoutNonce, perspective, visibility, counts]);

  // Re-run when the layout algorithm or its options change.
  const layoutKey = JSON.stringify(layout);
  const firstLayoutKey = useRef(layoutKey);
  useEffect(() => {
    if (firstLayoutKey.current === layoutKey) return;
    firstLayoutKey.current = layoutKey;
    runLayout(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useImperativeHandle(ref, () => ({
    cy: () => cyRef.current,
    fit: () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements().not(".gone"), padding: 50 } }, { duration: 250 }),
    zoomBy: (f) => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.animate({ zoom: { level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 150 });
    },
    runLayout: () => runLayout(false),
    centerOn: (id) => {
      const cy = cyRef.current;
      const n = cy?.getElementById(id);
      if (!cy || !n || n.empty()) return;
      cy.$(":selected").unselect();
      n.select();
      cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300 });
      n.addClass("flash");
      setTimeout(() => n.removeClass("flash"), 1200);
    },
    select: (ids) => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.batch(() => {
        cy.$(":selected").unselect();
        ids.forEach((id) => cy.getElementById(id).select());
      });
    },
    selectAll: () => cyRef.current?.elements().not(".gone").select(),
    clearSelection: () => cyRef.current?.$(":selected").unselect(),
    selectedNodeIds: () => cyRef.current?.$("node:selected").map((n) => n.id()) ?? [],
    positions: () => {
      const out: Record<string, { x: number; y: number }> = {};
      cyRef.current?.nodes().forEach((n) => {
        out[n.id()] = { ...n.position() };
      });
      return out;
    },
    setPositions: (pos) => {
      Object.entries(pos).forEach(([id, p]) => posCache.current.set(id, p));
      const cy = cyRef.current;
      cy?.batch(() => Object.entries(pos).forEach(([id, p]) => cy.getElementById(id).position(p)));
    },
    viewport: () => ({ zoom: cyRef.current?.zoom() ?? 1, pan: { ...(cyRef.current?.pan() ?? { x: 0, y: 0 }) } }),
    setViewport: (v) => cyRef.current?.viewport({ zoom: v.zoom, pan: v.pan }),
    png: (transparent) =>
      (cyRef.current?.png({ output: "blob", full: true, scale: 2, bg: transparent ? undefined : CANVAS_BG }) as unknown as Blob) ?? null,
    svg: () => (cyRef.current ? (cyRef.current as unknown as { svg: (o: object) => string }).svg({ full: true, bg: CANVAS_BG }) : null),
  }));

  return (
    <div className="absolute inset-0" onContextMenu={(e) => e.preventDefault()}>
      <div ref={hostRef} data-bloom-canvas className="absolute inset-0" />
      {tip && (
        <div
          className="pointer-events-none absolute z-30 max-w-xs rounded border border-ink-600 bg-ink-850/95 px-2 py-1 text-[11px] shadow-xl"
          style={{ left: tip.x + 14, top: tip.y + 14 }}
        >
          <div className="font-semibold text-ink-100">{tip.title}</div>
          {tip.lines.map((l, i) => (
            <div key={i} className="truncate text-ink-300">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
