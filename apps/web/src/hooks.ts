import { useEffect, useRef, useState } from "react";
import { OperationsApiError } from "./api.js";
import type { LoadState } from "./components/async-state.js";

export function stateForError(error: unknown): LoadState {
  if (error instanceof OperationsApiError && error.status === 401) return "disconnected";
  if (error instanceof OperationsApiError && (error.code === "runtime_unverifiable" || error.code === "source_changed")) return "unknown";
  return "error";
}

export function useRead<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T>();
  const [state, setState] = useState<LoadState>("loading");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState((value) => data === undefined ? "loading" : value);
    void loader(controller.signal).then((value) => { if (active) { setData(value); setState("ready"); } }).catch((error: unknown) => {
      if (active && !(error instanceof DOMException && error.name === "AbortError")) setState(stateForError(error));
    });
    return () => { active = false; controller.abort(); };
  }, [...deps, version]);
  return { data, state, reload: () => setVersion((value) => value + 1) };
}

export function useVisiblePolling<T>(loader: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T>();
  const [state, setState] = useState<LoadState>("loading");
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false, timer: number | undefined, controller: AbortController | undefined, generation = 0;
    const run = async (current: number) => {
      if (stopped || document.hidden || current !== generation) return;
      controller = new AbortController();
      try { const value = await loader(controller.signal); if (!stopped) { setData(value); setState("ready"); } }
      catch (error) { if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) setState(stateForError(error)); }
      finally { if (!stopped && !document.hidden && current === generation) timer = window.setTimeout(() => void run(current), intervalMs); }
    };
    const restart = () => { generation++; if (timer !== undefined) clearTimeout(timer); controller?.abort(); if (!document.hidden) void run(generation); };
    reload.current = restart;
    const visibility = () => restart();
    document.addEventListener("visibilitychange", visibility);
    restart();
    return () => { stopped = true; generation++; controller?.abort(); if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, deps);
  return { data, state, reload: () => reload.current() };
}
