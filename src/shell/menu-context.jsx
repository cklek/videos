import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

const MenuContext = createContext(null);

function mergeSections(bySource) {
  const merged = {};
  for (const sections of Object.values(bySource)) {
    if (!sections) continue;
    for (const [key, value] of Object.entries(sections)) {
      if (Array.isArray(value)) {
        merged[key] = [...(merged[key] || []), ...value];
      } else if (key === "extra") {
        merged.extra = merged.extra || value;
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export function MenuProvider({ children }) {
  const [bySource, setBySource] = useState({});
  const value = useMemo(
    () => ({ sections: mergeSections(bySource), setBySource }),
    [bySource],
  );
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

export function useMenuSections() {
  return useContext(MenuContext)?.sections || {};
}

export function useAppMenu(sections, deps = []) {
  const id = useId();
  const context = useContext(MenuContext);
  const setBySource = context?.setBySource;
  useEffect(() => {
    if (!setBySource) return undefined;
    setBySource((current) => ({ ...current, [id]: sections }));
    return () =>
      setBySource((current) => {
        const { [id]: _gone, ...rest } = current;
        return rest;
      });
  }, [setBySource, id, ...deps]);
}
