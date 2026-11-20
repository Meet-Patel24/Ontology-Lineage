import {
  BookOpen,
  ChevronDown,
  Download,
  Expand,
  Filter,
  FolderOpen,
  Globe,
  Map as MapIcon,
  Maximize,
  MessageSquareQuote,
  Minimize2,
  Pencil,
  Presentation,
  Redo2,
  RefreshCw,
  Save,
  Settings,
  Undo2,
  WifiOff,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { type Diagnosis, type ExploreSchema, type GraphResult, type Token, exploreApi } from "../bloom/api";
import { BloomCanvas, type BloomCanvasHandle, type ContextTarget } from "../bloom/BloomCanvas";
import { EXPLORER_MENU_LABEL } from "../bloom/constants";
import { ContextMenu, type MenuActions } from "../bloom/ContextMenu";
import { FilterPanel, LayoutOptionsPopover, OpenSceneDialog, PhraseManager, SettingsDialog } from "../bloom/dialogs";
import { nodesCsv, relsCsv, sceneCypher } from "../bloom/exporters";
import { CardList, Inspector, Legend, Minimap } from "../bloom/panels";
import { PerspectiveEditor } from "../bloom/PerspectiveEditor";
import { uid, usePerspectives } from "../bloom/perspective";
import { isSavedScene, type SavedScene, useSavedScenes } from "../bloom/savedScenes";
import { LAYOUTS, type LayoutName, useBloomSettings, useScene, useView } from "../bloom/sceneStore";
import { SearchBar, type SearchBarHandle } from "../bloom/SearchBar";
import { computeVisibility } from "../bloom/visibility";
import { makeZip } from "../bloom/zip";
import { copyText, downloadBlob, downloadText, timestampSlug } from "../lib/format";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";

type Dialog = "phrases" | "open" | "settings" | null;

const SESSION_KEY = "lineage-studio.bloom.session";

function readSession(): SavedScene | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return isSavedScene(data) && Object.keys(data.nodes).length ? data : null;
  } catch {
    return null;
  }
}

export function BloomPage() {
  const health = useApp((s) => s.health);
  const page = useApp((s) => s.page);
  const openInQuery = useApp((s) => s.openInQuery);
  const canvas = useRef<BloomCanvasHandle>(null);
  const searchBar = useRef<SearchBarHandle>(null);
  /** The single in-flight search / overview request (a new one cancels it). */
  const inflight = useRef<{ key: string; ctrl: AbortController } | null>(null);
  const started = useRef(false);
  const lastDone = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [dbTotal, setDbTotal] = useState<number | null>(null);

  const [schema, setSchema] = useState<ExploreSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [lastCypher, setLastCypher] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ nodes: string[]; rels: string[] }>({ nodes: [], rels: [] });
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showMinimap, setShowMinimap] = useState(false);
  const [presentation, setPresentation] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showPerspective, setShowPerspective] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showLayoutOpts, setShowLayoutOpts] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);

  const scene = useScene();
  const { filters, legendHidden, setFilters } = useView();
  const settings = useBloomSettings();
  const perspectives = usePerspectives();
  const perspective = perspectives.active();
  const saveScene = useSavedScenes((s) => s.save);

  const live = health?.mode !== "snapshot";

  // ---- schema ---------------------------------------------------------------------
  const loadSchema = useCallback(
    async (refresh = false) => {
      try {
        const s = await exploreApi.schema(refresh);
        setSchema(s);
        setSchemaError(null);
        usePerspectives.getState().ensureDefault(s);
        if (refresh) toast.success("Schema refreshed", `${s.labels.length} labels, ${s.relationship_types.length} relationship types`);
      } catch (e) {
        setSchemaError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [],
  );
  useEffect(() => {
    if (live && health?.connected) void loadSchema();
  }, [live, health?.connected, loadSchema]);

  // On first open: restore this browser session's scene, else draw the graph (like Bloom).
  useEffect(() => {
    // Only when the Bloom page is actually open (it stays mounted, hidden, while other pages are shown).
    if (page !== "bloom" || !live || !health?.connected || started.current) return; // `started` also absorbs StrictMode's double effect
    started.current = true;
    const saved = readSession();
    if (saved) {
      canvas.current?.setPositions(saved.positions ?? {});
      scene.load({ nodes: saved.nodes, rels: saved.rels, hidden: saved.hidden, pinned: saved.pinned, name: saved.name });
      if (saved.viewport) setTimeout(() => canvas.current?.setViewport(saved.viewport!), 80);
    } else if (useBloomSettings.getState().loadOnOpen && Object.keys(useScene.getState().nodes).length === 0) {
      void loadOverview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, live, health?.connected]);

  // Keep the scene for this browser session (restored on reload).
  useEffect(() => {
    const save = () => {
      const st = useScene.getState();
      if (!Object.keys(st.nodes).length) {
        sessionStorage.removeItem(SESSION_KEY);
        return;
      }
      try {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            id: "session",
            name: st.name,
            savedAt: Date.now(),
            nodes: st.nodes,
            rels: st.rels,
            hidden: st.hidden,
            pinned: st.pinned,
            positions: canvas.current?.positions() ?? {},
            viewport: canvas.current?.viewport(),
            perspectiveId: null,
            filters: useView.getState().filters,
            layout: useBloomSettings.getState().layout,
          }),
        );
      } catch {
        /* storage full or blocked: not critical */
      }
    };
    const onVis = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const counts = useMemo(() => Object.fromEntries((schema?.labels ?? []).map((l) => [l.name, l.count])), [schema]);
  const visibility = useMemo(
    () => computeVisibility(scene.nodes, scene.rels, scene.hidden, perspective, filters, legendHidden, counts),
    [scene.nodes, scene.rels, scene.hidden, perspective, filters, legendHidden, counts],
  );

  // ---- graph operations ---------------------------------------------------------------
  const ingest = (
    g: GraphResult,
    what: string,
    opts: { anchor?: string | null; relayout?: boolean; replace?: boolean; focus?: boolean } = {},
  ) => {
    setLastCypher(g.cypher);
    setDiagnosis(null);
    if (g.nodes.length === 0) {
      // One explanation instead of a toast storm.
      if (g.diagnosis) setDiagnosis(g.diagnosis);
      else toast.info("No results", what);
      return 0;
    }
    const { added, skipped } = scene.add(g, opts);
    const notes = [];
    if (g.total_nodes !== undefined && g.total_nodes > g.nodes.length)
      notes.push(`Showing ${g.nodes.length.toLocaleString()} of ${g.total_nodes.toLocaleString()} nodes. Use search to focus.`);
    else if (g.truncated) notes.push(`${what} results were truncated at the limit.`);
    if (skipped) notes.push(`${skipped} nodes were not added: the scene holds at most 2,000 nodes.`);
    setBanner(notes.length ? notes.join(" ") : null);
    if (added === 0 && !opts.focus) toast.info("Nothing new", "All results are already in the scene.");
    return added;
  };

  /** One request at a time: a new one cancels the previous; an identical one already in flight is ignored. */
  const single = async <T,>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    if (inflight.current?.key === key) return null;
    // Accidental repeats (Enter + ▶, double presses) right after it finished are ignored too.
    if (lastDone.current.key === key && Date.now() - lastDone.current.at < 1000) return null;
    inflight.current?.ctrl.abort();
    const ctrl = new AbortController();
    inflight.current = { key, ctrl };
    setRunning(true);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return null;
      throw e;
    } finally {
      if (inflight.current?.ctrl === ctrl) {
        inflight.current = null;
        lastDone.current = { key, at: Date.now() };
        setRunning(false);
      }
    }
  };

  const loadOverview = async () => {
    try {
      const limit = useBloomSettings.getState().overviewLimit;
      const g = await single(`overview:${limit}`, (signal) => exploreApi.overview(limit, signal));
      if (!g) return;
      setDbTotal(g.total_nodes ?? null);
      ingest(g, "Overview", { replace: true, relayout: true });
    } catch (e) {
      fail("Could not load the graph", e);
    }
  };

  const fail = (title: string, e: unknown) => toast.error(title, e instanceof ApiError ? e.message : String(e));

  const runSearch = async (tokens: Token[]) => {
    const key = `search:${JSON.stringify(tokens.map(({ display: _d, ...t }) => t))}`;
    try {
      const ph = tokens.length === 1 && tokens[0].kind === "phrase" ? tokens[0] : null;
      const g = await single(key, (signal) =>
        ph
          ? exploreApi.runPhrase(ph.value, ph.params ?? {}, settings.searchLimit, signal)
          : exploreApi.search(tokens, settings.searchLimit, signal),
      );
      if (!g) return;
      // Like Bloom: results are added to the scene (unless "Search replaces scene" is on), then selected and zoomed to.
      ingest(g, "Search", { relayout: true, focus: true, replace: settings.searchReplaces });
    } catch (e) {
      fail("Search failed", e);
    }
  };

  const expand = async (ids: string[], relTypes?: string[], direction: "in" | "out" | "both" = "both") => {
    try {
      const g = await exploreApi.expand(ids, { relTypes, direction, limit: settings.expandLimit });
      const added = ingest(g, "Expand", { anchor: ids.length === 1 ? ids[0] : null, relayout: ids.length !== 1 });
      if (added) toast.success(`Added ${added} node${added === 1 ? "" : "s"}`);
    } catch (e) {
      fail("Expand failed", e);
    }
  };

  const actions: MenuActions = {
    expand: (ids, relTypes, dir) => void expand(ids, relTypes, dir),
    inspect: () => setInspectorOpen(true),
    dismiss: (ids) => scene.dismiss(ids),
    dismissOthers: (ids) => scene.dismissOthers(ids),
    selectRelated: (ids) => {
      const cy = canvas.current?.cy();
      if (!cy) return;
      const col = cy.collection();
      ids.forEach((id) => col.merge(cy.getElementById(id).closedNeighborhood()));
      canvas.current?.select(col.not(".gone").map((e) => e.id()));
    },
    hide: (ids) => scene.hide(ids),
    togglePin: (ids) => scene.togglePin(ids),
    lineage: async (id) => {
      try {
        ingest(await exploreApi.lineage(id, settings.searchLimit), "Lineage", { relayout: true });
      } catch (e) {
        fail("Lineage failed", e);
      }
    },
    shortestPath: async (a, b) => {
      try {
        const g = await exploreApi.paths(a, b, 6);
        if (!g.nodes.length) return toast.info("No path", "No path within 6 hops.");
        ingest(g, "Shortest path", { relayout: false });
        setTimeout(() => canvas.current?.select([...g.nodes.map((n) => n.elementId), ...g.relationships.map((r) => r.elementId)]), 50);
      } catch (e) {
        fail("Shortest path failed", e);
      }
    },
    copyId: async (id) => {
      const n = scene.nodes[id];
      const text = n && typeof n.properties.id === "string" ? n.properties.id : id;
      if (await copyText(text)) toast.success("Id copied", text);
    },
    fit: () => canvas.current?.fit(),
    relayout: () => scene.relayout(),
    clearScene: () => scene.clear(),
    overview: () => void loadOverview(),
    showAll: () => {
      scene.showAll();
      useView.getState().resetLegend();
    },
  };

  // ---- keyboard shortcuts ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        canvas.current?.selectAll();
      } else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        useScene.getState().undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        useScene.getState().redo();
      } else if (e.key === "Escape") {
        canvas.current?.clearSelection();
        setMenu(null);
        if (presentation) setPresentation(false);
      } else if (e.key === "Delete") {
        const ids = canvas.current?.selectedNodeIds() ?? [];
        if (ids.length) useScene.getState().dismiss(ids);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentation]);

  // ---- scenes ----------------------------------------------------------------------------
  const currentScene = (name = scene.name): SavedScene => ({
    id: sceneId ?? uid(),
    name,
    savedAt: Date.now(),
    nodes: scene.nodes,
    rels: scene.rels,
    hidden: scene.hidden,
    pinned: scene.pinned,
    positions: canvas.current?.positions() ?? {},
    perspectiveId: perspective?.id ?? null,
    filters,
    layout: settings.layout,
    viewport: canvas.current?.viewport(),
  });

  const doSave = () => {
    const s = currentScene();
    saveScene(s);
    setSceneId(s.id);
    toast.success("Scene saved", s.name);
  };

  const openScene = (s: SavedScene) => {
    canvas.current?.setPositions(s.positions ?? {});
    scene.load({ nodes: s.nodes, rels: s.rels, hidden: s.hidden, pinned: s.pinned, name: s.name });
    if (s.filters) setFilters(s.filters);
    if (s.perspectiveId && perspectives.perspectives.some((p) => p.id === s.perspectiveId)) perspectives.setActive(s.perspectiveId);
    setSceneId(s.id);
    setDialog(null);
    if (s.viewport) setTimeout(() => canvas.current?.setViewport(s.viewport!), 80);
    toast.success("Scene opened", s.name);
  };

  const importScene = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      if (!isSavedScene(data)) throw new Error("Not a Bloom scene file");
      const s = { ...data, id: uid(), savedAt: Date.now() };
      saveScene(s);
      openScene(s);
    } catch (e) {
      toast.error("Import failed", (e as Error).message);
    }
  };

  // ---- export ---------------------------------------------------------------------------
  const base = () => `${scene.name.replace(/\W+/g, "_") || "scene"}-${timestampSlug()}`;
  const exp = {
    png: (transparent: boolean) => {
      const b = canvas.current?.png(transparent);
      if (b) downloadBlob(b, `${base()}.png`);
    },
    svg: () => {
      const s = canvas.current?.svg();
      if (s) downloadText(s, `${base()}.svg`, "image/svg+xml");
    },
    csv: () =>
      downloadBlob(
        makeZip([
          { name: "nodes.csv", content: nodesCsv(Object.values(scene.nodes)) },
          { name: "relationships.csv", content: relsCsv(Object.values(scene.rels)) },
        ]),
        `${base()}-csv.zip`,
      ),
    cypher: () => downloadText(sceneCypher(Object.values(scene.nodes), Object.values(scene.rels)), `${base()}.cypher`),
    json: () => downloadText(JSON.stringify(currentScene(), null, 2), `${base()}.scene.json`, "application/json"),
  };

  const nodeCount = Object.keys(scene.nodes).length;
  const selectedSet = useMemo(() => new Set(selection.nodes), [selection.nodes]);

  if (!live) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center text-sm text-ink-300">
          <WifiOff className="mx-auto mb-3 text-amber-600" />
          {EXPLORER_MENU_LABEL} needs a live Neo4j connection. It is not available in snapshot mode.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" style={{ background: "#ffffff" }}>
      {/* top bar */}
      {!presentation && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 text-sm">
          <span className="text-ink-300">Perspectives</span>
          <span className="h-5 w-px bg-ink-700" />
          <select
            value={perspective?.id ?? ""}
            onChange={(e) => perspectives.setActive(e.target.value)}
            className="max-w-[220px] rounded bg-transparent px-1 py-1 font-medium text-ink-100 hover:bg-ink-800"
          >
            {perspectives.perspectives.map((p) => (
              <option key={p.id} value={p.id} className="bg-ink-900">
                {p.name}
              </option>
            ))}
          </select>
          <TopIcon title="Edit perspective" active={showPerspective} onClick={() => setShowPerspective((v) => !v)}>
            <BookOpen size={16} />
          </TopIcon>
          <TopIcon title="Refresh schema" onClick={() => void loadSchema(true)}>
            <RefreshCw size={16} />
          </TopIcon>
          <span className="h-5 w-px bg-ink-700" />
          <TopIcon title="Undo (Ctrl+Z)" onClick={scene.undo} disabled={!scene.past.length}>
            <Undo2 size={16} />
          </TopIcon>
          <TopIcon title="Redo (Ctrl+Y)" onClick={scene.redo} disabled={!scene.future.length}>
            <Redo2 size={16} />
          </TopIcon>
          <div className="flex flex-1 justify-center">
            <SceneName />
          </div>
          <TopIcon title="Search phrases" onClick={() => setDialog("phrases")}>
            <MessageSquareQuote size={16} />
          </TopIcon>
          <TopIcon title="Open scene" onClick={() => setDialog("open")}>
            <FolderOpen size={16} />
          </TopIcon>
          <TopIcon title="Save scene" onClick={doSave} disabled={!nodeCount}>
            <Save size={16} />
          </TopIcon>
          <div className="relative">
            <button
              onClick={() => setShowExport((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-3 py-1 text-sm font-semibold hover:border-accent hover:text-accent"
            >
              <Download size={14} /> Export <ChevronDown size={13} />
            </button>
            {showExport && (
              <div className="absolute right-0 top-9 z-50 w-56 rounded-md border border-ink-600 bg-ink-850 py-1 text-xs shadow-2xl" onMouseLeave={() => setShowExport(false)}>
                {[
                  ["PNG (dark background)", () => exp.png(false)],
                  ["PNG (transparent)", () => exp.png(true)],
                  ["SVG", exp.svg],
                  ["CSV (nodes + relationships, zip)", exp.csv],
                  ["Cypher that reproduces the scene", exp.cypher],
                  ["Scene JSON", exp.json],
                ].map(([label, fn]) => (
                  <button
                    key={label as string}
                    disabled={!nodeCount}
                    onClick={() => {
                      setShowExport(false);
                      (fn as () => void)();
                    }}
                    className="block w-full px-3 py-1.5 text-left hover:bg-ink-700 disabled:opacity-40"
                  >
                    {label as string}
                  </button>
                ))}
                <div className="my-1 border-t border-ink-700" />
                <button
                  disabled={!nodeCount}
                  onClick={() => {
                    setShowExport(false);
                    openInQuery(sceneCypher(Object.values(scene.nodes), Object.values(scene.rels)));
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-ink-700 disabled:opacity-40"
                >
                  Open scene Cypher in Query
                </button>
                {lastCypher && (
                  <button
                    onClick={() => {
                      setShowExport(false);
                      openInQuery(lastCypher);
                    }}
                    className="block w-full px-3 py-1.5 text-left hover:bg-ink-700"
                  >
                    Open last search Cypher in Query
                  </button>
                )}
              </div>
            )}
          </div>
          <TopIcon title="Settings" onClick={() => setDialog("settings")}>
            <Settings size={16} />
          </TopIcon>
        </div>
      )}

      {/* canvas area */}
      <div className="relative min-h-0 flex-1 overflow-hidden" onClick={() => setMenu(null)}>
        <BloomCanvas
          ref={canvas}
          perspective={perspective}
          counts={counts}
          visibility={visibility}
          onSelection={(s) => {
            setSelection(s);
            if (s.nodes.length || s.rels.length) setInspectorOpen(true);
          }}
          onExpand={(id) => void expand([id])}
          onContext={setMenu}
          onZoom={setZoom}
        />

        {schemaError && (
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-800">
            Could not load the schema: {schemaError}
          </div>
        )}

        {!presentation && (
          <div className="absolute left-4 top-4 z-30 flex items-start gap-2">
            <SearchBar ref={searchBar} perspective={perspective} onRun={(t) => void runSearch(t)} onClearScene={() => scene.clear()} running={running} disabled={!schema} />
            <div className="relative">
              <button
                title="Filter the scene"
                onClick={() => setShowFilters((v) => !v)}
                className={`flex h-[44px] w-[44px] items-center justify-center rounded-lg border bg-ink-900/95 shadow-xl ${
                  filters.enabled && filters.conditions.length ? "border-accent text-accent" : "border-ink-600 text-ink-300 hover:text-ink-100"
                }`}
              >
                <Filter size={17} />
              </button>
              {showFilters && <FilterPanel schema={schema} onClose={() => setShowFilters(false)} />}
            </div>
          </div>
        )}

        {banner && !presentation && (
          <div className="absolute left-1/2 top-20 z-20 flex -translate-x-1/2 items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800">
            {banner}
            <button onClick={() => setBanner(null)} className="text-amber-700 hover:text-amber-900">
              ✕
            </button>
          </div>
        )}

        {diagnosis && !presentation && (
          <div className="absolute left-4 top-[76px] z-20 w-[560px] max-w-[calc(100vw-120px)] rounded-lg border border-amber-500/40 bg-ink-900/[0.97] px-3 py-2 text-xs shadow-xl">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 font-semibold text-amber-700">No results.</span>
              <span className="flex-1 text-ink-100" data-diagnosis>
                {diagnosis.message}
              </span>
              <button onClick={() => setDiagnosis(null)} className="text-ink-400 hover:text-ink-100" title="Dismiss">
                ✕
              </button>
            </div>
            {diagnosis.fixes.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-ink-400">Try:</span>
                {diagnosis.fixes.map((f) => (
                  <button
                    key={f.title}
                    onClick={() => {
                      searchBar.current?.setTokens(f.tokens);
                      void runSearch(f.tokens);
                    }}
                    className="rounded-full border border-accent/60 px-2 py-0.5 text-accent hover:bg-accent/15"
                  >
                    {f.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {nodeCount === 0 && !running && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="text-center text-sm text-ink-400">
              <div className="mb-1 text-base text-ink-300">Type a label, e.g. PolicyChunk, and press Enter</div>
              <div className="text-xs">
                Chain relationships (PolicyChunk GOVERNS Column), filter by property (Column name risk_bucket) or use a search phrase (Lineage of risk_bucket).
              </div>
            </div>
          </div>
        )}

        {/* right toolbar */}
        <div className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-ink-600 bg-ink-900/95 p-1 shadow-xl">
          <SideIcon title="Toggle minimap" active={showMinimap} onClick={() => setShowMinimap((v) => !v)}>
            <MapIcon size={16} />
          </SideIcon>
          <SideIcon title={presentation ? "Exit presentation mode (Esc)" : "Presentation mode"} active={presentation} onClick={() => setPresentation((v) => !v)}>
            {presentation ? <Minimize2 size={16} /> : <Presentation size={16} />}
          </SideIcon>
          <SideIcon title="Show whole graph" onClick={() => void loadOverview()}>
            <Globe size={16} />
          </SideIcon>
          <SideIcon title="Fit to screen" onClick={() => canvas.current?.fit()}>
            <Maximize size={16} />
          </SideIcon>
          <SideIcon title="Zoom in" onClick={() => canvas.current?.zoomBy(1.25)}>
            <ZoomIn size={16} />
          </SideIcon>
          <SideIcon title="Zoom out" onClick={() => canvas.current?.zoomBy(0.8)}>
            <ZoomOut size={16} />
          </SideIcon>
          <span className="py-1 text-[10px] tabular-nums text-ink-300">{Math.round(zoom * 100)}%</span>
        </div>

        {/* bottom right: minimap + layout */}
        <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
          {showMinimap && <Minimap getCy={() => canvas.current?.cy() ?? null} />}
          {!presentation && (
            <div className="relative flex items-center gap-1 rounded-lg border border-ink-600 bg-ink-900/95 px-2 py-1.5 shadow-xl">
              <select
                value={settings.layout.name}
                onChange={(e) => settings.setLayout({ name: e.target.value as LayoutName })}
                className="bg-transparent text-sm text-ink-100 outline-none"
                title="Layout"
              >
                {LAYOUTS.map((l) => (
                  <option key={l.value} value={l.value} className="bg-ink-900">
                    {l.label}
                  </option>
                ))}
              </select>
              <button title="Layout options" onClick={() => setShowLayoutOpts((v) => !v)} className="rounded p-1 text-ink-300 hover:text-ink-100">
                <Pencil size={14} />
              </button>
              <button title="Re-run layout" onClick={() => scene.relayout()} className="rounded p-1 text-ink-300 hover:text-ink-100">
                <Expand size={14} />
              </button>
              {showLayoutOpts && <LayoutOptionsPopover onClose={() => setShowLayoutOpts(false)} />}
            </div>
          )}
        </div>

        {/* bottom left: card list; bottom centre: legend */}
        {!presentation && nodeCount > 0 && (
          <div className="pointer-events-none absolute bottom-3 left-4 right-[300px] z-20 flex items-end gap-3">
            <CardList dbTotal={dbTotal} nodes={scene.nodes} visibility={visibility} perspective={perspective} counts={counts} selected={selectedSet} onPick={(id) => canvas.current?.centerOn(id)} />
            <Legend nodes={scene.nodes} rels={scene.rels} visibility={visibility} perspective={perspective} />
          </div>
        )}

        {!presentation && inspectorOpen && (selection.nodes.length > 0 || selection.rels.length > 0) && (
          <Inspector
            selection={selection}
            nodes={scene.nodes}
            rels={scene.rels}
            perspective={perspective}
            counts={counts}
            onExpand={(id, t, d) => void expand([id], t ? [t] : undefined, d ?? "both")}
            onPick={(id) => canvas.current?.centerOn(id)}
            onClose={() => setInspectorOpen(false)}
          />
        )}

        {showPerspective && !presentation && <PerspectiveEditor schema={schema} onClose={() => setShowPerspective(false)} />}

        {menu && (
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu
              target={menu}
              selectedNodes={selection.nodes}
              pinned={new Set(scene.pinned)}
              hasHidden={scene.hidden.length > 0 || legendHidden.length > 0}
              actions={actions}
              onClose={() => setMenu(null)}
            />
          </div>
        )}
      </div>

      {dialog === "phrases" && <PhraseManager onClose={() => setDialog(null)} />}
      {dialog === "open" && <OpenSceneDialog onOpen={openScene} onImport={(f) => void importScene(f)} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog schema={schema} onRefreshSchema={() => void loadSchema(true)} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SceneName() {
  const name = useScene((s) => s.name);
  const setName = useScene((s) => s.setName);
  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={(e) => !e.target.value.trim() && setName("Untitled Scene")}
      className="w-64 rounded bg-transparent px-2 py-1 text-center text-sm font-medium text-ink-100 outline-none hover:bg-ink-800 focus:bg-ink-800"
      title="Scene name (click to edit)"
      aria-label="Scene name"
    />
  );
}

function TopIcon({ children, title, onClick, active, disabled }: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1.5 ${active ? "bg-accent/20 text-accent" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"} disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

function SideIcon({ children, title, onClick, active }: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded p-1.5 ${active ? "bg-accent/20 text-accent" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"}`}
    >
      {children}
    </button>
  );
}
