import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ENode, ERel } from "./api";
import type { FilterState, LayoutOptions } from "./sceneStore";

export interface SavedScene {
  id: string;
  name: string;
  savedAt: number;
  nodes: Record<string, ENode>;
  rels: Record<string, ERel>;
  hidden: string[];
  pinned: string[];
  positions: Record<string, { x: number; y: number }>;
  perspectiveId: string | null;
  filters: FilterState;
  layout: LayoutOptions;
  viewport?: { zoom: number; pan: { x: number; y: number } };
}

interface SavedScenesStore {
  scenes: SavedScene[];
  save: (s: SavedScene) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
}

export const useSavedScenes = create<SavedScenesStore>()(
  persist(
    (set, get) => ({
      scenes: [],
      save: (s) => set({ scenes: [s, ...get().scenes.filter((x) => x.id !== s.id)] }),
      rename: (id, name) => set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, name } : s)) }),
      remove: (id) => set({ scenes: get().scenes.filter((s) => s.id !== id) }),
    }),
    { name: "lineage-studio.bloom.scenes", storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);

export function isSavedScene(v: unknown): v is SavedScene {
  const s = v as SavedScene;
  return !!s && typeof s === "object" && typeof s.nodes === "object" && typeof s.rels === "object";
}
