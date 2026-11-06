// A choice remembered in this browser (localStorage), read through useSyncExternalStore so the server and the render
// that hydrates see null and the stored value arrives right after, with no effect setting state. When storage is
// refused, the choice is still kept for this page in memory, so it switches without being remembered.

import { useCallback, useSyncExternalStore } from "react";

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

/** The value stored under `key` (null on the server, while hydrating, or when none is stored) and its setter. */
export function useRemembered(key: string): [string | null, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const remember = useCallback(
    (next: string) => {
      memory.set(key, next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Not remembered, still switched (memory).
      }
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [value, remember];
}
