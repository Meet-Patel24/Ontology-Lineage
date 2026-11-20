import { Braces, PanelLeftClose, PanelLeftOpen, Play, Trash2, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import { EmptyState } from "../components/ui";
import { parseCommand, splitStatements } from "../lib/statements";
import { useApp } from "../store/app";
import { type Frame, useFrames, useQueries } from "../store/queries";
import { toast } from "../store/toasts";
import { CypherEditor, type CypherEditorHandle } from "./query/CypherEditor";
import { ResultFrame } from "./query/ResultFrame";
import { SidePanel } from "./query/SidePanel";

export function QueryPage() {
  const editorRef = useRef<CypherEditorHandle>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [showParams, setShowParams] = useState(false);

  const health = useApp((s) => s.health);
  const schema = useApp((s) => s.schema);
  const pending = useApp((s) => s.pendingQuery);
  const clearPending = useApp((s) => s.clearPendingQuery);
  const setShowShortcuts = useApp((s) => s.setShowShortcuts);

  const frames = useFrames((s) => s.frames);
  const { addFrame, updateFrame, clearFrames } = useFrames.getState();
  const params = useQueries((s) => s.params);

  const snapshot = health?.mode === "snapshot";
  const database = health?.database ?? "neo4j";

  // ---- history navigation in the editor ---------------------------------------
  const histIdx = useRef(-1);
  const draft = useRef("");
  const onHistory = useCallback((dir: -1 | 1, current: string): string | null => {
    const history = useQueries.getState().history;
    if (dir === -1) {
      if (histIdx.current + 1 >= history.length) return null;
      if (histIdx.current === -1) draft.current = current;
      histIdx.current += 1;
      return history[histIdx.current].query;
    }
    if (histIdx.current <= -1) return null;
    histIdx.current -= 1;
    return histIdx.current === -1 ? draft.current : history[histIdx.current].query;
  }, []);

  // ---- execution ------------------------------------------------------------------
  const execute = useCallback(
    async (query: string, frameId?: string) => {
      const p = useQueries.getState().params;
      const id =
        frameId ??
        addFrame({ query, params: p, database, status: "running" });
      if (frameId) updateFrame(frameId, { status: "running", error: undefined, result: undefined, params: p });
      const started = performance.now();
      try {
        const result = await api.query(query, p);
        updateFrame(id, { status: "done", result });
        return { ok: true, ms: Math.round(performance.now() - started) };
      } catch (e) {
        const err = e instanceof ApiError ? { code: e.code, message: e.message } : { code: "Error", message: String(e) };
        updateFrame(id, { status: "error", error: err });
        return { ok: false, ms: Math.round(performance.now() - started) };
      }
    },
    [addFrame, updateFrame, database],
  );

  const runText = useCallback(
    async (text: string) => {
      const statements = splitStatements(text);
      if (statements.length === 0) return;
      histIdx.current = -1;
      let ok = true;
      let total = 0;
      let ranCypher = false;
      for (const stmt of statements) {
        const cmd = parseCommand(stmt);
        if (cmd) {
          const store = useQueries.getState();
          switch (cmd.kind) {
            case "param":
              store.setParam(cmd.name, cmd.value);
              addFrame({ query: stmt, params: {}, database, status: "done", info: { title: `Set parameter $${cmd.name}`, body: { [cmd.name]: cmd.value } } });
              break;
            case "params":
              if (cmd.value) store.setParams(cmd.value);
              addFrame({ query: stmt, params: {}, database, status: "done", info: { title: cmd.value ? "Parameters replaced" : "Current parameters", body: useQueries.getState().params } });
              break;
            case "clear":
              clearFrames();
              break;
            case "help":
              setShowShortcuts(true);
              break;
            default:
              addFrame({
                query: stmt,
                params: {},
                database,
                status: "error",
                error: { code: "UnknownCommand", message: `Unknown command ${cmd.text}. Try :param, :params, :clear or :help.` },
              });
          }
          continue;
        }
        ranCypher = true;
        const r = await execute(stmt);
        ok = ok && r.ok;
        total += r.ms;
      }
      if (ranCypher) useQueries.getState().addHistory({ query: text.trim(), at: Date.now(), durationMs: total, ok });
    },
    [execute, addFrame, clearFrames, database, setShowShortcuts],
  );

  const runFromEditor = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      void runText(text);
    },
    [runText],
  );

  const loadIntoEditor = useCallback((text: string) => {
    editorRef.current?.setValue(text);
    editorRef.current?.focus();
  }, []);

  const loadAndRun = useCallback(
    (text: string) => {
      loadIntoEditor(text);
      void runText(text);
    },
    [loadIntoEditor, runText],
  );

  // Queries handed over from other pages ("Open in Query").
  useEffect(() => {
    if (!pending) return;
    loadIntoEditor(pending.text);
    if (pending.run && !snapshot) void runText(pending.text);
    clearPending();
  }, [pending, loadIntoEditor, runText, clearPending, snapshot]);

  const rerun = useCallback((f: Frame) => void execute(f.query, f.id), [execute]);

  const vocab = useCallback(
    () => ({
      labels: (schema?.labels ?? []).map((l) => l.name),
      relationshipTypes: (schema?.relationship_types ?? []).map((r) => r.name),
      propertyKeys: (schema?.property_keys ?? []).map((p) => p.name),
    }),
    [schema],
  );

  const ordered = [...frames.filter((f) => f.pinned), ...frames.filter((f) => !f.pinned)];
  const paramCount = Object.keys(params).length;

  return (
    <div className="flex h-full min-h-0">
      {panelOpen && (
        <aside className="w-[300px] shrink-0 border-r border-ink-700 bg-ink-900">
          <SidePanel onLoad={loadIntoEditor} onRun={loadAndRun} getCurrent={() => editorRef.current?.getValue() ?? ""} />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {snapshot && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800">
            <WifiOff size={14} /> Live Cypher is unavailable in snapshot mode. The lineage pages still work on the offline
            snapshot; you can edit queries here and run them once connected.
          </div>
        )}
        {/* editor bar */}
        <div className="border-b border-ink-700 bg-ink-900 px-3 py-2">
          <div className="flex items-start gap-2 rounded-md border border-ink-600 bg-ink-950 px-2 focus-within:border-accent">
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className="mt-1.5 rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              title={panelOpen ? "Hide side panel" : "Show side panel"}
            >
              {panelOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <span className="mt-[9px] select-none font-mono text-sm text-accent">$</span>
            <CypherEditor ref={editorRef} onRun={runFromEditor} onHistory={onHistory} vocab={vocab} />
            <div className="relative mt-1 flex items-center gap-1">
              <button
                onClick={() => setShowParams((v) => !v)}
                className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs ${paramCount ? "text-accent" : "text-ink-400"} hover:bg-ink-800`}
                title="Query parameters"
              >
                <Braces size={14} />
                {paramCount > 0 && paramCount}
              </button>
              {showParams && <ParamsPopover onClose={() => setShowParams(false)} />}
              <button
                onClick={() => runFromEditor(editorRef.current?.getValue() ?? "")}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
                title="Run (Ctrl+Enter)"
              >
                <Play size={13} fill="currentColor" /> Run
              </button>
            </div>
          </div>
        </div>
        {/* stream */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {frames.length > 0 && (
            <div className="mb-2 flex justify-end">
              <button
                onClick={() => clearFrames()}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                title="Remove all unpinned frames (:clear)"
              >
                <Trash2 size={12} /> Clear stream
              </button>
            </div>
          )}
          <div className="space-y-3">
            {ordered.map((f) => (
              <ResultFrame key={f.id} frame={f} onRerun={rerun} />
            ))}
          </div>
          {frames.length === 0 && (
            <EmptyState title="Run a Cypher query to get started">
              Try <code className="rounded bg-ink-800 px-1 font-mono">MATCH (n) RETURN n LIMIT 25</code> and press{" "}
              <kbd className="rounded border border-ink-600 px-1">Ctrl</kbd>+<kbd className="rounded border border-ink-600 px-1">Enter</kbd>,
              or pick a sample from the side panel. Press <kbd className="rounded border border-ink-600 px-1">?</kbd> for shortcuts.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function ParamsPopover({ onClose }: { onClose: () => void }) {
  const params = useQueries((s) => s.params);
  const setParams = useQueries((s) => s.setParams);
  const [text, setText] = useState(() => JSON.stringify(params, null, 2));
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    try {
      const v = JSON.parse(text || "{}");
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("Parameters must be a JSON object");
      setParams(v);
      toast.success("Parameters updated");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="absolute right-0 top-10 z-40 w-96 rounded-md border border-ink-600 bg-ink-850 p-3 shadow-2xl">
      <div className="mb-1 text-xs font-semibold">Query parameters (JSON)</div>
      <p className="mb-2 text-[11px] text-ink-400">
        Referenced as <code className="font-mono">$name</code>. You can also type{" "}
        <code className="font-mono">:param name =&gt; value</code> in the editor.
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        spellCheck={false}
        rows={8}
        className="w-full rounded border border-ink-600 bg-ink-950 p-2 font-mono text-[11px] text-ink-100 outline-none focus:border-accent"
      />
      {error && <div className="mt-1 text-[11px] text-red-600">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button onClick={onClose} className="rounded px-2 py-1 text-xs text-ink-300 hover:bg-ink-700">
          Cancel
        </button>
        <button onClick={apply} className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white">
          Apply
        </button>
      </div>
    </div>
  );
}
