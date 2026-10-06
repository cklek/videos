import { useSyncExternalStore } from "react";

export const THEMES = [
  { id: "daylight", label: "Daylight", dark: false },
  { id: "spacetime", label: "Spacetime", dark: true },
  { id: "build-knight", label: "Build Knight", dark: true },
  { id: "chicago95", label: "Chicago95", dark: false },
  { id: "lisp", label: "Lisp", dark: true },
];

export const DEFAULT_THEME = "daylight";
const STORAGE_KEY = "theme";
const EVENT = "theme-change";
const PARENT_MESSAGE_TYPE = "webc:theme-change";

function broadcastTheme(id) {
  const theme = THEMES.find((entry) => entry.id === id);
  if (!theme || typeof window === "undefined" || window.parent === window)
    return;
  window.parent.postMessage(
    {
      type: PARENT_MESSAGE_TYPE,
      version: 1,
      theme: { id: theme.id, label: theme.label, dark: theme.dark },
    },
    "*",
  );
}

const LEGACY = { day: "daylight", dim: "spacetime", night: "build-knight" };

export function isTheme(value) {
  return THEMES.some((theme) => theme.id === value);
}

export function readTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const id = Object.hasOwn(LEGACY, stored) ? LEGACY[stored] : stored;
    if (isTheme(id)) return id;
  } catch {
    /* no store: the default is fine */
  }
  const current = document.documentElement.dataset.theme;
  return isTheme(current) ? current : DEFAULT_THEME;
}

export function applyTheme(id) {
  const theme = THEMES.find((entry) => entry.id === id);
  if (!theme) return;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.dark);
  root.style.colorScheme = theme.dark ? "dark" : "light";
}

export function setTheme(id) {
  if (!isTheme(id)) return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* still applies for this page */
  }
  applyTheme(id);
  window.dispatchEvent(new Event(EVENT));
  broadcastTheme(id);
}

function subscribe(callback) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useTheme() {
  const id = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

export function themeViewItems(theme) {
  return [
    { id: "theme-label", kind: "label", label: "Theme" },
    ...THEMES.map((entry) => ({
      id: `theme-${entry.id}`,
      label: entry.label,
      checked: theme.id === entry.id,
      kind: "checkbox",
      onSelect: () => setTheme(entry.id),
    })),
  ];
}

if (typeof window !== "undefined") broadcastTheme(readTheme());
