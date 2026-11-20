import {
  BookOpen,
  Clock,
  Database,
  Download,
  Folder,
  FolderPlus,
  Pencil,
  Play,
  Save,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { labelColor } from "../../lib/colors";
import { downloadText, quoteIdent, timeAgo } from "../../lib/format";
import { SAMPLE_QUERIES } from "../../lib/samples";
import { useApp } from "../../store/app";
import { type SavedQuery, useQueries } from "../../store/queries";
import { toast } from "../../store/toasts";
import { Skeleton } from "../../components/ui";

type Tab = "saved" | "history" | "db" | "samples";

interface Props {
  /** Load text into the editor. */
  onLoad: (text: string) => void;
  /** Load and run. */
  onRun: (text: string) => void;
  /** Current editor text (for "save current"). */
  getCurrent: () => string;
}

export function SidePanel({ onLoad, onRun, getCurrent }: Props) {
  const [tab, setTab] = useState<Tab>("samples");
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "saved", label: "Saved", icon: <Star size={14} /> },
    { id: "history", label: "History", icon: <Clock size={14} /> },
    { id: "db", label: "Database", icon: <Database size={14} /> },
    { id: "samples", label: "Samples", icon: <BookOpen size={14} /> },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-4 border-b border-ink-700">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            title={t.label}
            className={`flex flex-col items-center gap-0.5 border-b-2 py-2 text-[10px] ${
              tab === t.id ? "border-accent text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "saved" && <SavedTab onLoad={onLoad} onRun={onRun} getCurrent={getCurrent} />}
        {tab === "history" && <HistoryTab onLoad={onLoad} />}
        {tab === "db" && <DbInfoTab onLoad={onLoad} onRun={onRun} />}
        {tab === "samples" && <SamplesTab onLoad={onLoad} onRun={onRun} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SavedTab({ onLoad, onRun, getCurrent }: Props) {
  const { saved, folders, saveQuery, renameQuery, updateQuery, deleteQuery, addFolder, renameFolder, deleteFolder, importSaved } =
    useQueries();
  const fileRef = useRef<HTMLInputElement>(null);

  const saveCurrent = () => {
    const q = getCurrent().trim();
    if (!q) return toast.warning("Nothing to save", "The editor is empty.");
    const name = window.prompt("Name for this query", q.split("\n")[0].slice(0, 50));
    if (!name) return;
    saveQuery(name.trim(), q);
    toast.success("Query saved", name);
  };

  const exportAll = () =>
    downloadText(JSON.stringify({ folders, queries: saved }, null, 2), "lineage-studio-saved-queries.json", "application/json");

  const importFile = async (file: File) => {
    try {
      const n = importSaved(JSON.parse(await file.text()));
      toast.success(`Imported ${n} quer${n === 1 ? "y" : "ies"}`);
    } catch (e) {
      toast.error("Import failed", (e as Error).message);
    }
  };

  const groups: (string | null)[] = [...folders, null];
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap gap-1">
        <SmallBtn onClick={saveCurrent} icon={<Save size={12} />}>
          Save current
        </SmallBtn>
        <SmallBtn
          onClick={() => {
            const n = window.prompt("Folder name");
            if (n?.trim()) addFolder(n.trim());
          }}
          icon={<FolderPlus size={12} />}
        >
          Folder
        </SmallBtn>
        <SmallBtn onClick={exportAll} icon={<Download size={12} />}>
          Export
        </SmallBtn>
        <SmallBtn onClick={() => fileRef.current?.click()} icon={<Upload size={12} />}>
          Import
        </SmallBtn>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {saved.length === 0 && folders.length === 0 && (
        <div className="rounded border border-dashed border-ink-700 p-3 text-center text-ink-400">
          No saved queries yet. Write a query and click <b>Save current</b>. Saved queries live in this browser.
        </div>
      )}
      {groups.map((folder) => {
        const items = saved.filter((q) => q.folder === folder);
        if (folder === null && items.length === 0) return null;
        return (
          <div key={folder ?? "__root"}>
            {folder !== null && (
              <div className="group mb-1 flex items-center gap-1.5 font-semibold text-ink-300">
                <Folder size={13} /> <span className="flex-1 truncate">{folder}</span>
                <IconBtn
                  title="Rename folder"
                  onClick={() => {
                    const n = window.prompt("Rename folder", folder);
                    if (n?.trim()) renameFolder(folder, n.trim());
                  }}
                >
                  <Pencil size={11} />
                </IconBtn>
                <IconBtn
                  title="Delete folder (queries move to the root)"
                  onClick={() => window.confirm(`Delete folder "${folder}"?`) && deleteFolder(folder)}
                >
                  <Trash2 size={11} />
                </IconBtn>
              </div>
            )}
            <div className={folder !== null ? "ml-3 space-y-1 border-l border-ink-700 pl-2" : "space-y-1"}>
              {items.length === 0 && <div className="text-[11px] text-ink-500">Empty</div>}
              {items.map((q) => (
                <SavedItem
                  key={q.id}
                  q={q}
                  folders={folders}
                  onLoad={onLoad}
                  onRun={onRun}
                  onRename={() => {
                    const n = window.prompt("Rename query", q.name);
                    if (n?.trim()) renameQuery(q.id, n.trim());
                  }}
                  onMove={(f) => updateQuery(q.id, { folder: f })}
                  onDelete={() => window.confirm(`Delete "${q.name}"?`) && deleteQuery(q.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SavedItem({
  q,
  folders,
  onLoad,
  onRun,
  onRename,
  onMove,
  onDelete,
}: {
  q: SavedQuery;
  folders: string[];
  onLoad: (t: string) => void;
  onRun: (t: string) => void;
  onRename: () => void;
  onMove: (f: string | null) => void;
  onDelete: () => void;
}) {
  return (
    <div className="group rounded border border-ink-700 bg-ink-850 p-2 hover:border-ink-500">
      <div className="flex items-center gap-1">
        <button className="min-w-0 flex-1 truncate text-left font-medium text-ink-100" onClick={() => onLoad(q.query)} title="Load into editor">
          {q.name}
        </button>
        <IconBtn title="Run" onClick={() => onRun(q.query)}>
          <Play size={11} />
        </IconBtn>
        <IconBtn title="Rename" onClick={onRename}>
          <Pencil size={11} />
        </IconBtn>
        <IconBtn title="Delete" onClick={onDelete}>
          <Trash2 size={11} />
        </IconBtn>
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-ink-400">{q.query}</div>
      {folders.length > 0 && (
        <select
          value={q.folder ?? ""}
          onChange={(e) => onMove(e.target.value || null)}
          className="mt-1 hidden w-full rounded border border-ink-700 bg-ink-900 px-1 py-0.5 text-[10px] text-ink-300 group-hover:block"
          title="Move to folder"
        >
          <option value="">(no folder)</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HistoryTab({ onLoad }: { onLoad: (t: string) => void }) {
  const history = useQueries((s) => s.history);
  const clear = useQueries((s) => s.clearHistory);
  if (history.length === 0)
    return <div className="rounded border border-dashed border-ink-700 p-3 text-center text-xs text-ink-400">No queries run yet.</div>;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center justify-between text-ink-400">
        <span>Last {history.length} queries</span>
        <button onClick={() => window.confirm("Clear history?") && clear()} className="hover:text-ink-100">
          Clear
        </button>
      </div>
      {history.map((h, i) => (
        <button
          key={i}
          onClick={() => onLoad(h.query)}
          className="block w-full rounded border border-ink-700 bg-ink-850 p-2 text-left hover:border-ink-500"
          title="Load into editor"
        >
          <div className="line-clamp-3 whitespace-pre-wrap font-mono text-[11px] text-ink-200">{h.query}</div>
          <div className="mt-1 flex justify-between text-[10px] text-ink-500">
            <span className={h.ok ? "" : "text-red-600"}>{h.ok ? "ok" : "failed"}</span>
            <span>
              {h.durationMs !== null ? `${h.durationMs} ms · ` : ""}
              {timeAgo(h.at)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DbInfoTab({ onLoad, onRun }: { onLoad: (t: string) => void; onRun: (t: string) => void }) {
  const schema = useApp((s) => s.schema);
  const health = useApp((s) => s.health);
  if (!schema)
    return (
      <div className="space-y-2">
        {health && !health.connected ? (
          <div className="text-xs text-ink-400">Not connected to a database.</div>
        ) : (
          <>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
          </>
        )}
      </div>
    );
  const pick = (q: string) => (health?.mode === "snapshot" ? onLoad(q) : onRun(q));
  return (
    <div className="space-y-4 text-xs">
      <Section title={`Node labels (${schema.labels.length})`}>
        {schema.labels.map((l) => (
          <Chip
            key={l.name}
            color={labelColor(l.name)}
            onClick={() => pick(`MATCH (n:${quoteIdent(l.name)})\nRETURN n LIMIT 25`)}
            label={l.name}
            count={l.count}
            round
          />
        ))}
      </Section>
      <Section title={`Relationship types (${schema.relationship_types.length})`}>
        {schema.relationship_types.map((r) => (
          <Chip
            key={r.name}
            onClick={() => pick(`MATCH p = ()-[:${quoteIdent(r.name)}]->()\nRETURN p LIMIT 25`)}
            label={r.name}
            count={r.count}
          />
        ))}
      </Section>
      <Section title={`Property keys (${schema.property_keys.length})`}>
        {schema.property_keys.map((p) => {
          const k = quoteIdent(p.name);
          return (
            <Chip
              key={p.name}
              onClick={() =>
                pick(
                  `MATCH (n) WHERE n.${k} IS NOT NULL\nRETURN DISTINCT 'node' AS entity, n.${k} AS ${k} LIMIT 25\nUNION ALL\nMATCH ()-[r]-() WHERE r.${k} IS NOT NULL\nRETURN DISTINCT 'relationship' AS entity, r.${k} AS ${k} LIMIT 25`,
                )
              }
              label={p.name}
              count={p.count}
              subtle
            />
          );
        })}
      </Section>
      <p className="text-[10px] text-ink-500">Click an item to run a sample query.</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-semibold text-ink-300">{title}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({
  label,
  count,
  onClick,
  color,
  round,
  subtle,
}: {
  label: string;
  count: number;
  onClick: () => void;
  color?: string;
  round?: boolean;
  subtle?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-0.5 text-[11px] transition hover:brightness-125 ${round ? "rounded-full" : "rounded"} ${
        color ? "font-semibold text-[#111827]" : subtle ? "border border-ink-600 text-ink-200" : "bg-ink-600 text-ink-100"
      }`}
      style={color ? { background: color } : undefined}
      title={`${label}: ${count}`}
    >
      {label}
      <span className={color ? "opacity-70" : "text-ink-400"}>{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function SamplesTab({ onLoad, onRun }: { onLoad: (t: string) => void; onRun: (t: string) => void }) {
  return (
    <div className="space-y-2">
      {SAMPLE_QUERIES.map((s, i) => (
        <div key={i} className="group rounded border border-ink-700 bg-ink-850 p-2.5 hover:border-accent/60">
          <div className="flex items-center gap-1">
            <button onClick={() => onLoad(s.query)} className="flex-1 text-left text-xs font-semibold text-ink-100">
              {i + 1}. {s.title}
            </button>
            <IconBtn title="Run" onClick={() => onRun(s.query)}>
              <Play size={12} />
            </IconBtn>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-400">{s.description}</div>
          <button onClick={() => onLoad(s.query)} className="mt-1.5 block w-full text-left" title="Load into editor">
            <pre className="line-clamp-3 whitespace-pre-wrap rounded bg-ink-950 p-1.5 font-mono text-[10px] text-ink-300">{s.query}</pre>
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SmallBtn({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 text-[11px] text-ink-200 hover:border-accent hover:text-accent"
    >
      {icon}
      {children}
    </button>
  );
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100">
      {children}
    </button>
  );
}
