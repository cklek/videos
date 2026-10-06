import { useCallback, useMemo, useSyncExternalStore } from "react";
export { pathWithSearchParams } from "./url-path";
export const SEARCH_PARAMS_EVENT = "search-params";

function hasWindow() {
  return typeof window !== "undefined";
}

function currentSearch() {
  return hasWindow() ? window.location.search : "";
}

function subscribeSearchParams(onStoreChange) {
  if (!hasWindow()) return () => {};
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener(SEARCH_PARAMS_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener(SEARCH_PARAMS_EVENT, onStoreChange);
  };
}

export function readSearchParam(name) {
  if (!hasWindow()) return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function hasSearchParam(name) {
  if (!hasWindow()) return false;
  return new URLSearchParams(window.location.search).has(name);
}

export function readEnumSearchParam(name, allowed, fallback) {
  const value = readSearchParam(name);
  return value && allowed.includes(value) ? value : fallback;
}

export function readOptionalEnumSearchParam(name, allowed) {
  const value = readSearchParam(name);
  return value && allowed.includes(value) ? value : null;
}

export function readIntegerSearchParam(name, options = {}) {
  const value = readSearchParam(name);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (options.min != null && parsed < options.min) return null;
  if (options.max != null && parsed > options.max) return null;
  return parsed;
}

export function useSearchParamsSnapshot() {
  const search = useSyncExternalStore(
    subscribeSearchParams,
    currentSearch,
    () => "",
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useSearchParam(name) {
  const params = useSearchParamsSnapshot();
  return params.get(name);
}

export function useHasSearchParam(name) {
  const params = useSearchParamsSnapshot();
  return params.has(name);
}

export function useEnumSearchParam(name, allowed, fallback) {
  const value = useSearchParam(name);
  return value && allowed.includes(value) ? value : fallback;
}

export function useOptionalEnumSearchParam(name, allowed) {
  const value = useSearchParam(name);
  return value && allowed.includes(value) ? value : null;
}

export function useIntegerSearchParam(name, options = {}) {
  const value = useSearchParam(name);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (options.min != null && parsed < options.min) return null;
  if (options.max != null && parsed > options.max) return null;
  return parsed;
}

export function useUpdateSearchParams() {
  return useCallback(updateSearchParams, []);
}

export function updateSearchParams(updates, options = {}) {
  if (!hasWindow()) return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options.mode === "push") {
    window.history.pushState(window.history.state, "", next);
  } else {
    window.history.replaceState(window.history.state, "", next);
  }
  window.dispatchEvent(new Event(SEARCH_PARAMS_EVENT));
}

export function replaceSearchParams(nextSearch, options = {}) {
  if (!hasWindow()) return;
  const search =
    typeof nextSearch === "string" ? nextSearch : nextSearch.toString();
  const normalizedSearch = search
    ? search.startsWith("?")
      ? search
      : `?${search}`
    : "";
  const next = `${window.location.pathname}${normalizedSearch}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options.mode === "push") {
    window.history.pushState(window.history.state, "", next);
  } else {
    window.history.replaceState(window.history.state, "", next);
  }
  window.dispatchEvent(new Event(SEARCH_PARAMS_EVENT));
}
