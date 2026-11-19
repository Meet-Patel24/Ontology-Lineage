import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { QueryResponse } from "../api/types";

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  folder: string | null;
  createdAt: number;
}

export interface HistoryEntry {
  query: string;
  at: number;
  durationMs: number | null;
  ok: boolean;
}

export type FrameStatus = "running" | "done" | "error";

export interface Frame {
  id: string;
  query: string;
  params: Record<string, unknown>;
  database: string;
  status: FrameStatus;
  startedAt: number;
  result?: QueryResponse;
  error?: { code: string; message: string };
  /** For client commands (:param etc.) */
  info?: { title: string; body?: unknown };
  pinned: boolean;
  collapsed: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---- persisted: saved queries, history, params -------------------------------

interface QueryStore {
  saved: SavedQuery[];
  folders: string[];
  history: HistoryEntry[];
  params: Record<string, unknown>;

  saveQuery: (name: string, query: string, folder?: string | null) => void;
  renameQuery: (id: string, name: string) => void;
  updateQuery: (id: string, patch: Partial<Omit<SavedQuery, "id">>) => void;
  deleteQuery: (id: string) => void;
  addFolder: (name: string) => void;
  renameFolder: (oldName: string, newName: string) => void;
  deleteFolder: (name: string) => void;
  importSaved: (data: unknown) => number;

  addHistory: (e: HistoryEntry) => void;
  clearHistory: () => void;

  setParam: (name: string, value: unknown) => void;
  setParams: (params: Record<string, unknown>) => void;
}

export const useQueries = create<QueryStore>()(
  persist(
    (set, get) => ({
      saved: [],
      folders: [],
      history: [],
      params: {},

      saveQuery: (name, query, folder = null) =>
        set({ saved: [...get().saved, { id: uid(), name, query, folder, createdAt: Date.now() }] }),
      renameQuery: (id, name) => set({ saved: get().saved.map((q) => (q.id === id ? { ...q, name } : q)) }),
      updateQuery: (id, patch) => set({ saved: get().saved.map((q) => (q.id === id ? { ...q, ...patch } : q)) }),
      deleteQuery: (id) => set({ saved: get().saved.filter((q) => q.id !== id) }),
      addFolder: (name) => {
        if (!get().folders.includes(name)) set({ folders: [...get().folders, name] });
      },
      renameFolder: (oldName, newName) =>
        set({
          folders: get().folders.map((f) => (f === oldName ? newName : f)),
          saved: get().saved.map((q) => (q.folder === oldName ? { ...q, folder: newName } : q)),
        }),
      deleteFolder: (name) =>
        set({
          folders: get().folders.filter((f) => f !== name),
          saved: get().saved.map((q) => (q.folder === name ? { ...q, folder: null } : q)),
        }),
      importSaved: (data) => {
        const obj = data as { folders?: unknown; queries?: unknown };
        const list = Array.isArray(data) ? data : Array.isArray(obj?.queries) ? obj.queries : null;
        if (!list) throw new Error("Expected an array of queries or { folders, queries }");
        const imported: SavedQuery[] = [];
        for (const item of list as Record<string, unknown>[]) {
          if (typeof item?.query !== "string") continue;
          imported.push({
            id: uid(),
            name: typeof item.name === "string" ? item.name : item.query.slice(0, 40),
            query: item.query,
            folder: typeof item.folder === "string" ? item.folder : null,
            createdAt: Date.now(),
          });
        }
        const folders = new Set([
          ...get().folders,
          ...(Array.isArray(obj?.folders) ? (obj.folders as unknown[]).filter((f): f is string => typeof f === "string") : []),
          ...imported.map((q) => q.folder).filter((f): f is string => !!f),
        ]);
        set({ saved: [...get().saved, ...imported], folders: [...folders] });
        return imported.length;
      },

      addHistory: (e) => {
        const prev = get().history.filter((h) => h.query !== e.query);
        set({ history: [e, ...prev].slice(0, 100) });
      },
      clearHistory: () => set({ history: [] }),

      setParam: (name, value) => set({ params: { ...get().params, [name]: value } }),
      setParams: (params) => set({ params }),
    }),
    {
      name: "lineage-studio.queries",
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);

// ---- result frames (in memory, survive page switches) ------------------------

interface FrameStore {
  frames: Frame[];
  addFrame: (f: Omit<Frame, "id" | "pinned" | "collapsed" | "startedAt">) => string;
  updateFrame: (id: string, patch: Partial<Frame>) => void;
  removeFrame: (id: string) => void;
  clearFrames: () => void;
}

export const useFrames = create<FrameStore>((set, get) => ({
  frames: [],
  addFrame: (f) => {
    const id = uid();
    set({ frames: [{ ...f, id, pinned: false, collapsed: false, startedAt: Date.now() }, ...get().frames].slice(0, 50) });
    return id;
  },
  updateFrame: (id, patch) => set({ frames: get().frames.map((f) => (f.id === id ? { ...f, ...patch } : f)) }),
  removeFrame: (id) => set({ frames: get().frames.filter((f) => f.id !== id) }),
  clearFrames: () => set({ frames: get().frames.filter((f) => f.pinned) }),
}));
