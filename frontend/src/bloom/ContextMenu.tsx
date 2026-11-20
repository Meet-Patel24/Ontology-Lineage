import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  GitFork,
  Globe,
  Info,
  Maximize,
  Pin,
  Route,
  Share2,
  Trash2,
  Waypoints,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type NodeDetail, exploreApi } from "./api";
import type { ContextTarget } from "./BloomCanvas";

export interface MenuActions {
  expand: (ids: string[], relTypes?: string[], direction?: "in" | "out" | "both") => void;
  inspect: () => void;
  dismiss: (ids: string[]) => void;
  dismissOthers: (ids: string[]) => void;
  selectRelated: (ids: string[]) => void;
  hide: (ids: string[]) => void;
  togglePin: (ids: string[]) => void;
  lineage: (id: string) => void;
  shortestPath: (a: string, b: string) => void;
  copyId: (id: string) => void;
  fit: () => void;
  relayout: () => void;
  clearScene: () => void;
  showAll: () => void;
  overview: () => void;
}

export function ContextMenu({
  target,
  selectedNodes,
  pinned,
  hasHidden,
  actions,
  onClose,
}: {
  target: ContextTarget;
  selectedNodes: string[];
  pinned: Set<string>;
  hasHidden: boolean;
  actions: MenuActions;
  onClose: () => void;
}) {
  const [sub, setSub] = useState(false);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const ids = target.kind === "node" ? (selectedNodes.includes(target.id!) ? selectedNodes : [target.id!]) : [];

  useEffect(() => {
    if (target.kind !== "node" || ids.length !== 1) return;
    exploreApi.node(ids[0]).then(setDetail).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const style = { left: Math.min(target.x, window.innerWidth - 480), top: Math.min(target.y, window.innerHeight - 420) };

  if (target.kind === "canvas") {
    return (
      <Menu style={style}>
        <Item icon={<Maximize size={13} />} label="Fit to screen" onClick={act(actions.fit)} />
        <Item icon={<Share2 size={13} />} label="Re-run layout" onClick={act(actions.relayout)} />
        <Item icon={<Globe size={13} />} label="Show whole graph" onClick={act(actions.overview)} />
        {hasHidden && <Item icon={<Eye size={13} />} label="Show all hidden" onClick={act(actions.showAll)} />}
        <Item icon={<Eraser size={13} />} label="Clear scene" onClick={act(actions.clearScene)} danger />
      </Menu>
    );
  }
  if (target.kind === "rel") {
    return (
      <Menu style={style}>
        <Item icon={<Info size={13} />} label="Inspect" onClick={act(actions.inspect)} />
        <Item icon={<Copy size={13} />} label="Copy id" onClick={act(() => actions.copyId(target.id!))} />
      </Menu>
    );
  }

  const allPinned = ids.every((i) => pinned.has(i));
  const types = [...new Set((detail?.neighbours ?? []).map((n) => n.type))];
  return (
    <Menu style={style}>
      <div className="relative" onMouseEnter={() => setSub(true)} onMouseLeave={() => setSub(false)}>
        <Item icon={<Waypoints size={13} />} label={`Expand${ids.length > 1 ? ` (${ids.length})` : ""}`} onClick={act(() => actions.expand(ids))} trailing={<ChevronRight size={13} />} />
        {sub && (
          <div className="absolute left-full top-0 w-56 rounded-md border border-ink-600 bg-ink-850 py-1 shadow-2xl">
            <Item label="All" onClick={act(() => actions.expand(ids))} />
            <Item icon={<ArrowLeft size={13} />} label="Incoming" onClick={act(() => actions.expand(ids, undefined, "in"))} />
            <Item icon={<ArrowRight size={13} />} label="Outgoing" onClick={act(() => actions.expand(ids, undefined, "out"))} />
            {types.length > 0 && <div className="my-1 border-t border-ink-700" />}
            {(detail?.neighbours ?? []).map((n) => (
              <Item
                key={`${n.type}-${n.direction}`}
                icon={n.direction === "in" ? <ArrowLeft size={13} /> : <ArrowRight size={13} />}
                label={n.type}
                mono
                trailing={<span className="text-[10px] text-ink-400">{n.count}</span>}
                onClick={act(() => actions.expand(ids, [n.type], n.direction))}
              />
            ))}
          </div>
        )}
      </div>
      <Item icon={<Info size={13} />} label="Inspect" onClick={act(actions.inspect)} />
      <Item icon={<GitFork size={13} />} label="Show lineage" onClick={act(() => actions.lineage(ids[0]))} />
      {ids.length === 2 && <Item icon={<Route size={13} />} label="Shortest path" onClick={act(() => actions.shortestPath(ids[0], ids[1]))} />}
      <Item icon={<Share2 size={13} />} label="Select related" onClick={act(() => actions.selectRelated(ids))} />
      <div className="my-1 border-t border-ink-700" />
      <Item icon={<Pin size={13} />} label={allPinned ? "Unpin position" : "Pin position"} onClick={act(() => actions.togglePin(ids))} />
      <Item icon={<EyeOff size={13} />} label="Hide" onClick={act(() => actions.hide(ids))} />
      <Item icon={<XCircle size={13} />} label="Dismiss" onClick={act(() => actions.dismiss(ids))} />
      <Item icon={<Trash2 size={13} />} label="Dismiss others" onClick={act(() => actions.dismissOthers(ids))} />
      <div className="my-1 border-t border-ink-700" />
      <Item icon={<Copy size={13} />} label="Copy id" onClick={act(() => actions.copyId(ids[0]))} />
    </Menu>
  );
}

function Menu({ children, style }: { children: React.ReactNode; style: React.CSSProperties }) {
  return (
    <div
      className="absolute z-40 w-56 rounded-md border border-ink-600 bg-ink-850 py-1 text-xs shadow-2xl"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

function Item({
  icon,
  label,
  onClick,
  trailing,
  danger,
  mono,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  trailing?: React.ReactNode;
  danger?: boolean;
  mono?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-700 ${danger ? "text-red-700" : "text-ink-100"}`}
    >
      <span className="w-4 text-ink-400">{icon}</span>
      <span className={`flex-1 truncate ${mono ? "font-mono" : ""}`}>{label}</span>
      {trailing}
    </button>
  );
}
