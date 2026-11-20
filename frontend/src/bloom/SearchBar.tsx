import { ArrowLeft, ArrowLeftRight, ArrowRight, Eraser, Loader2, Play, Search, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type Direction, type Suggestion, type SuggestionCategory, type Token, exploreApi } from "./api";
import { hashColor, type Perspective } from "./perspective";

type Group = "all" | "nodes" | "rels" | "values" | "phrases";
const GROUPS: { id: Group; label: string; cats: SuggestionCategory[] }[] = [
  { id: "all", label: "All", cats: [] },
  { id: "nodes", label: "Nodes", cats: ["node"] },
  { id: "rels", label: "Relationships", cats: ["relationship"] },
  { id: "values", label: "Property values", cats: ["property", "value"] },
  { id: "phrases", label: "Search phrases", cats: ["phrase"] },
];

const DIR_NEXT: Record<Direction, Direction> = { out: "in", in: "both", both: "out" };

interface Props {
  perspective: Perspective | null;
  onRun: (tokens: Token[]) => void;
  onClearScene: () => void;
  running: boolean;
  disabled?: boolean;
}

export interface SearchBarHandle {
  /** Replace the tokens (e.g. a fix suggested for an empty result). */
  setTokens: (t: Token[]) => void;
}

export const SearchBar = forwardRef<SearchBarHandle, Props>(function SearchBar({ perspective, onRun, onClearScene, running, disabled }, ref) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [text, setText] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [group, setGroup] = useState<Group>("all");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    setTokens: (t) => {
      setTokens(t);
      setText("");
      setOpen(false);
    },
  }));

  // fetch suggestions (debounced, cancellable)
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      exploreApi
        .suggest(text, tokens, ctrl.signal)
        .then((r) => {
          setItems(r.suggestions);
          setActive(0);
        })
        .catch(() => !ctrl.signal.aborted && setItems([]))
        .finally(() => !ctrl.signal.aborted && setLoading(false));
    }, 160);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [text, tokens, open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const visible = useMemo(() => {
    const g = GROUPS.find((x) => x.id === group)!;
    return g.cats.length ? items.filter((i) => g.cats.includes(i.category)) : items;
  }, [items, group]);

  const choose = (s: Suggestion) => {
    if (s.category === "error") return;
    if (s.fill !== undefined && s.tokens.length === 0) {
      setText(s.fill);
      inputRef.current?.focus();
      return;
    }
    const newTokens = s.tokens.map((t) => (t.kind === "phrase" ? { ...t, display: s.title } : t));
    const next = [...tokens, ...newTokens];
    setTokens(next);
    setText("");
    inputRef.current?.focus();
    // Phrases and free text are complete searches on their own: run immediately.
    if (newTokens.some((t) => t.kind === "phrase" || t.kind === "text")) {
      setOpen(false);
      onRun(next);
    }
  };

  const run = () => {
    let toks = tokens;
    if (text.trim()) {
      // Typed text that was not turned into a token: use the best suggestion, else free text.
      const best = visible[active];
      if (best && best.category !== "error" && best.tokens.length) toks = [...tokens, ...best.tokens];
      else if (!tokens.length) toks = [{ kind: "text", value: text.trim() }];
      setTokens(toks);
      setText("");
    }
    if (!toks.length) return;
    setOpen(false);
    onRun(toks);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && visible[active]) choose(visible[active]);
      else run();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Backspace" && text === "" && tokens.length) {
      setTokens(tokens.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const chipColor = (t: Token) => {
    if (t.kind === "label") return perspective?.labels[t.value]?.color ?? hashColor(t.value);
    if (t.kind === "rel") return perspective?.rels[t.value]?.color ?? "#6b7a90";
    if (t.kind === "phrase") return "#AE63E4";
    return "#94A3B8";
  };

  return (
    <div ref={boxRef} className="w-[560px] max-w-[calc(100vw-120px)]">
      <div className="flex items-center gap-2">
        <div
          className={`flex min-h-[44px] flex-1 flex-wrap items-center gap-1 rounded-lg border bg-ink-900/95 px-2 py-1 shadow-xl backdrop-blur ${open ? "border-accent" : "border-ink-600"}`}
          onClick={() => inputRef.current?.focus()}
        >
          <Search size={16} className="mx-1 shrink-0 text-ink-400" />
          {tokens.map((t, i) => (
            <TokenChip
              key={i}
              token={t}
              color={chipColor(t)}
              onRemove={() => setTokens(tokens.filter((_, j) => j !== i))}
              onDirection={
                t.kind === "rel"
                  ? () => setTokens(tokens.map((x, j) => (j === i ? { ...x, direction: DIR_NEXT[x.direction ?? "out"] } : x)))
                  : undefined
              }
            />
          ))}
          <input
            ref={inputRef}
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder={tokens.length ? "" : "Search graph, e.g. PolicyChunk"}
            className="min-w-[120px] flex-1 bg-transparent py-1 text-sm text-ink-100 outline-none placeholder:italic placeholder:text-ink-500"
            aria-label="Search graph"
          />
          {loading && open && <Loader2 size={14} className="shrink-0 animate-spin text-ink-400" />}
          {(tokens.length > 0 || text) && (
            <button
              title="Clear search"
              onClick={(e) => {
                e.stopPropagation();
                setTokens([]);
                setText("");
              }}
              className="shrink-0 rounded p-1 text-ink-400 hover:text-ink-100"
            >
              <X size={14} />
            </button>
          )}
          <button
            title="Run search (Ctrl+Enter)"
            onClick={(e) => {
              e.stopPropagation();
              run();
            }}
            disabled={disabled || running}
            className="shrink-0 rounded-full p-1.5 text-ink-200 hover:bg-accent hover:text-white disabled:opacity-40"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          </button>
        </div>
        <button
          title="Clear scene"
          onClick={onClearScene}
          className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-lg border border-ink-600 bg-ink-900/95 text-ink-300 shadow-xl hover:border-accent hover:text-accent"
        >
          <Eraser size={17} />
        </button>
      </div>

      {open && (
        <div className="mt-1 overflow-hidden rounded-lg border border-ink-600 bg-ink-900/[0.98] shadow-2xl">
          <div className="flex flex-wrap gap-1 border-b border-ink-700 px-2 py-1.5">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setGroup(g.id)}
                className={`rounded border px-2 py-0.5 text-[11px] ${group === g.id ? "border-accent bg-accent/15 text-accent" : "border-ink-600 text-ink-300 hover:text-ink-100"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="max-h-[52vh] overflow-auto">
            {visible.length === 0 && !loading && (
              <div className="px-4 py-3 text-xs text-ink-400">
                {tokens.length ? "No suggestions. Press Ctrl+Enter to run the search." : "Type a label, e.g. PolicyChunk, and press Enter."}
              </div>
            )}
            {visible.map((s, i) => (
              <button
                key={`${s.category}-${s.title}-${i}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s)}
                className={`flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left ${
                  i === active ? "border-accent bg-ink-800" : "border-transparent"
                } ${s.category === "error" ? "cursor-default" : ""}`}
              >
                <SuggestionBody s={s} perspective={perspective} />
                {i === active && s.category !== "error" && (
                  <span className="ml-auto shrink-0 text-[10px] text-ink-400">
                    <b className="text-ink-200">Enter</b> {s.fill !== undefined && !s.tokens.length ? "to type value" : "add to search"}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function SuggestionBody({ s, perspective }: { s: Suggestion; perspective: Perspective | null }) {
  if (s.category === "error") return <span className="text-xs text-red-700">{s.title}</span>;
  const pill = (text: string, color: string, rounded = true) => (
    <span
      className={`shrink-0 px-2.5 py-0.5 text-xs font-semibold text-[#111827] ${rounded ? "rounded-full" : "rounded"}`}
      style={{ background: color }}
    >
      {text}
    </span>
  );
  const labelColor = (l?: string | null) => (l ? perspective?.labels[l]?.color ?? hashColor(l) : "#8a94a6");
  let main: React.ReactNode;
  switch (s.category) {
    case "node":
      main = pill(s.title, labelColor(s.title));
      break;
    case "relationship":
      main = (
        <span className="flex items-center gap-1 font-mono text-xs text-ink-100">
          {s.tokens[0]?.direction === "in" ? <ArrowLeft size={12} /> : null}
          <span className="rounded border border-ink-500 px-1.5 py-0.5">{s.title}</span>
          {s.tokens[0]?.direction !== "in" ? <ArrowRight size={12} /> : null}
        </span>
      );
      break;
    case "property":
      main = (
        <span className="flex items-center gap-2 text-xs">
          {s.chip && pill(s.chip, labelColor(s.chip))}
          <span className="font-mono text-ink-100">{s.title}</span>
        </span>
      );
      break;
    case "value":
      main = (
        <span className="flex min-w-0 items-center gap-2 text-xs">
          {s.chip && pill(s.chip, labelColor(s.chip))}
          <span className="truncate text-ink-100">{s.title}</span>
        </span>
      );
      break;
    case "phrase":
      main = pill(s.title, "#D2A8F2", false);
      break;
    default:
      main = <span className="text-xs text-ink-100">{s.title}</span>;
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {main}
      {s.subtitle && <span className="truncate text-[11px] text-ink-400">{s.subtitle}</span>}
      {typeof s.count === "number" && <span className="text-[10px] text-ink-500">{s.count}</span>}
    </span>
  );
}

function TokenChip({ token, color, onRemove, onDirection }: { token: Token; color: string; onRemove: () => void; onDirection?: () => void }) {
  const dirIcon =
    token.direction === "in" ? <ArrowLeft size={11} /> : token.direction === "both" ? <ArrowLeftRight size={11} /> : <ArrowRight size={11} />;
  const text = token.display ?? token.value;
  const style =
    token.kind === "label" || token.kind === "phrase"
      ? { background: color, color: "#111827" }
      : token.kind === "rel"
        ? { border: `1px solid ${color}`, color: "#111827" }
        : { background: "#EEF2F8", color: "#111827" };
  return (
    <span
      className={`group flex items-center gap-1 px-2 py-0.5 text-xs font-semibold ${token.kind === "label" ? "rounded-full" : "rounded"}`}
      style={style}
      title={token.kind}
    >
      {token.kind === "property" && <span className="opacity-60">.</span>}
      {token.kind === "value" && <span className="opacity-60">=</span>}
      {token.kind === "text" && <span className="opacity-60">“</span>}
      <span className={token.kind === "rel" ? "font-mono" : ""}>{text}</span>
      {token.kind === "text" && <span className="opacity-60">”</span>}
      {onDirection && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDirection();
          }}
          title="Toggle direction (out / in / both)"
          className="rounded px-0.5 hover:bg-black/10"
        >
          {dirIcon}
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-50 hover:opacity-100"
        title="Remove"
      >
        <X size={11} />
      </button>
    </span>
  );
}
