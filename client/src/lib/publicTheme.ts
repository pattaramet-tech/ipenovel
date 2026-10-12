export type PublicThemePreference = "light" | "dark" | "system";
export type ResolvedPublicTheme = "light" | "dark";

export const PUBLIC_THEME_STORAGE_KEY = "ipenovel.public-theme";

export function parsePublicThemePreference(raw: string | null): PublicThemePreference {
  if (raw === null || raw === "") return "light";
  if (raw === "light") return "light";
  if (raw === "dark") return "dark";
  if (raw === "system") return "system";
  return "light";
}

export function resolvePublicTheme(
  preference: PublicThemePreference,
  prefersDark: boolean,
): ResolvedPublicTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

export function preferenceFromStorageEvent(event: {
  key: string | null;
  newValue: string | null;
}): PublicThemePreference | null {
  if (event.key === null) return "light";
  if (event.key !== PUBLIC_THEME_STORAGE_KEY) return null;
  return parsePublicThemePreference(event.newValue);
}

export function readBrowserPublicThemePreference(
  getStorage: () => Storage | null | undefined,
): PublicThemePreference {
  try {
    return readPublicThemePreference(getStorage());
  } catch {
    return "light";
  }
}

export function writeBrowserPublicThemePreference(
  getStorage: () => Storage | null | undefined,
  preference: PublicThemePreference,
): void {
  try {
    writePublicThemePreference(getStorage(), preference);
  } catch {}
}

export function readPublicThemePreference(storage: Storage | null | undefined): PublicThemePreference {
  if (!storage) return "light";
  try {
    return parsePublicThemePreference(storage.getItem(PUBLIC_THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

export function writePublicThemePreference(
  storage: Storage | null | undefined,
  preference: PublicThemePreference,
): void {
  if (!storage) return;
  try {
    storage.setItem(PUBLIC_THEME_STORAGE_KEY, preference);
  } catch {}
}

export function publicDarkThemeAttribute(
  resolved: ResolvedPublicTheme,
  paint: boolean,
): { "data-public-theme"?: "dark" } {
  if (!paint || resolved !== "dark") return {};
  return { "data-public-theme": "dark" };
}
