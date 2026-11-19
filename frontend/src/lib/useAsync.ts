import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { toast } from "../store/toasts";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: { code: string; message: string } | null;
}

/** Run `fn` whenever `deps` change; keeps the previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { toastErrors?: boolean } = {}): AsyncState<T> & {
  reload: () => void;
} {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof ApiError ? { code: e.code, message: e.message } : { code: "Error", message: String(e) };
        setState({ data: null, loading: false, error: err });
        if (opts.toastErrors !== false) toast.error(err.code, err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
