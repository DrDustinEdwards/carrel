import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** False on the server and in the render that hydrates, true after: what reads the browser waits for it. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** The browser's own time zone once hydrated; `fallback` (the server's) until then, so hydration matches its HTML. */
export function useBrowserZone<T extends string | null>(fallback: T): string | T {
  return useSyncExternalStore(
    noSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || fallback,
    () => fallback,
  );
}
