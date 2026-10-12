import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "wouter";
import { isPublicStorefrontPath } from "@/components/navbarVisibility";
import {
  preferenceFromStorageEvent,
  publicDarkThemeAttribute,
  readBrowserPublicThemePreference,
  resolvePublicTheme,
  writeBrowserPublicThemePreference,
  type PublicThemePreference,
  type ResolvedPublicTheme,
} from "@/lib/publicTheme";

type PublicThemeContextValue = {
  preference: PublicThemePreference;
  resolved: ResolvedPublicTheme;
  setPreference: (preference: PublicThemePreference) => void;
};

const PublicThemeContext = createContext<PublicThemeContextValue | undefined>(undefined);

export function PublicThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<PublicThemePreference>(() =>
    readBrowserPublicThemePreference(() => (typeof window !== "undefined" ? window.localStorage : null)),
  );
  const [mediaRevision, setMediaRevision] = useState(0);

  useEffect(() => {
    if (preference !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMediaRevision((n) => n + 1);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const next = preferenceFromStorageEvent({ key: event.key, newValue: event.newValue });
      if (next !== null) setPreferenceState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const prefersDark =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;

  const resolved = useMemo(
    () => resolvePublicTheme(preference, prefersDark),
    [preference, prefersDark, mediaRevision],
  );

  const setPreference = useCallback((next: PublicThemePreference) => {
    setPreferenceState(next);
    writeBrowserPublicThemePreference(() => window.localStorage, next);
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <PublicThemeContext.Provider value={value}>{children}</PublicThemeContext.Provider>;
}

export function usePublicTheme(): PublicThemeContextValue {
  const ctx = useContext(PublicThemeContext);
  if (!ctx) {
    throw new Error("usePublicTheme must be used within PublicThemeProvider");
  }
  return ctx;
}

export function usePublicStorefrontPageThemeProps(): { "data-public-theme"?: "dark" } {
  const [location] = useLocation();
  const { resolved } = usePublicTheme();
  return publicDarkThemeAttribute(resolved, isPublicStorefrontPath(location));
}
