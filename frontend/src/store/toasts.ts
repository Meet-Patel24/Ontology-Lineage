import { create } from "zustand";

export type ToastKind = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, title: string, message?: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
const recent = new Map<string, number>(); // key -> time shown
const DEDUPE_MS = 3000;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, title, message) => {
    // The same toast within 3 seconds is shown only once.
    const key = `${kind}|${title}|${message ?? ""}`;
    const now = Date.now();
    if (now - (recent.get(key) ?? 0) < DEDUPE_MS) return;
    recent.set(key, now);
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, title, message }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 8000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push("info", title, message),
  success: (title: string, message?: string) => useToasts.getState().push("success", title, message),
  error: (title: string, message?: string) => useToasts.getState().push("error", title, message),
  warning: (title: string, message?: string) => useToasts.getState().push("warning", title, message),
};
