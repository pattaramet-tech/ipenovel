import { useCallback, useEffect, useState } from "react";

export type ReaderFontFamily = "default" | "sarabun" | "notoSansThai" | "prompt" | "kanit" | "system";
export type ReaderTheme = "light" | "dark" | "sepia";

export interface ReaderPreferences {
  fontSize: number;
  fontFamily: ReaderFontFamily;
  lineHeight: number;
  paragraphSpacing: number;
  theme: ReaderTheme;
  /** Full-screen "Focus Mode" - collapses the reader's own header chrome
   *  while reading. Client-side only (see readerChromePresentation.ts for
   *  the derived on-screen state); never persisted server-side. */
  focusMode: boolean;
}

const STORAGE_KEY = "ipenovel_reader_preferences";

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 18,
  fontFamily: "default",
  lineHeight: 1.8,
  paragraphSpacing: 16,
  theme: "light",
  focusMode: false,
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const FONT_SIZE_STEP = 2;

export const LINE_HEIGHT_MIN = 1.4;
export const LINE_HEIGHT_MAX = 2.4;
export const LINE_HEIGHT_STEP = 0.1;

export const PARAGRAPH_SPACING_MIN = 8;
export const PARAGRAPH_SPACING_MAX = 40;
export const PARAGRAPH_SPACING_STEP = 4;

export const FONT_FAMILY_OPTIONS: { value: ReaderFontFamily; labelKey: string; stack: string | undefined }[] = [
  { value: "default", labelKey: "reader.fontDefault", stack: undefined },
  { value: "sarabun", labelKey: "Sarabun", stack: "'Sarabun', sans-serif" },
  { value: "notoSansThai", labelKey: "Noto Sans Thai", stack: "'Noto Sans Thai', sans-serif" },
  { value: "prompt", labelKey: "Prompt", stack: "'Prompt', sans-serif" },
  { value: "kanit", labelKey: "Kanit", stack: "'Kanit', sans-serif" },
  { value: "system", labelKey: "reader.fontSystem", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
];

function isValidFontFamily(value: unknown): value is ReaderFontFamily {
  return typeof value === "string" && FONT_FAMILY_OPTIONS.some((option) => option.value === value);
}

function isValidTheme(value: unknown): value is ReaderTheme {
  return value === "light" || value === "dark" || value === "sepia";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pure parser for the persisted `ipenovel_reader_preferences` value - no
 * localStorage/window access, so it's unit-testable on its own (see
 * useReaderPreferences.test.ts). Every field falls back independently to
 * DEFAULT_READER_PREFERENCES (a missing/wrong-typed/legacy-shaped field
 * never invalidates the others), and every return path builds a fresh
 * object - never the DEFAULT_READER_PREFERENCES reference itself, so a
 * caller can never mutate the shared default by mutating what this returns.
 */
export function parseStoredReaderPreferences(raw: string | null): ReaderPreferences {
  if (!raw) return { ...DEFAULT_READER_PREFERENCES };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_READER_PREFERENCES };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_READER_PREFERENCES };
  }
  const value = parsed as Record<string, unknown>;

  return {
    fontSize: typeof value.fontSize === "number"
      ? clamp(value.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX)
      : DEFAULT_READER_PREFERENCES.fontSize,
    fontFamily: isValidFontFamily(value.fontFamily) ? value.fontFamily : DEFAULT_READER_PREFERENCES.fontFamily,
    lineHeight: typeof value.lineHeight === "number"
      ? clamp(value.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)
      : DEFAULT_READER_PREFERENCES.lineHeight,
    paragraphSpacing: typeof value.paragraphSpacing === "number"
      ? clamp(value.paragraphSpacing, PARAGRAPH_SPACING_MIN, PARAGRAPH_SPACING_MAX)
      : DEFAULT_READER_PREFERENCES.paragraphSpacing,
    theme: isValidTheme(value.theme) ? value.theme : DEFAULT_READER_PREFERENCES.theme,
    // Legacy stored preferences (saved before Focus Mode existed) simply
    // don't have this key - `undefined` falls through to the same default
    // path as a wrong-typed value (string/number), both correctly landing
    // on `false`.
    focusMode: typeof value.focusMode === "boolean" ? value.focusMode : DEFAULT_READER_PREFERENCES.focusMode,
  };
}

function loadPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_READER_PREFERENCES };

  try {
    return parseStoredReaderPreferences(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_READER_PREFERENCES };
  }
}

/**
 * Reads/writes the reader's font & theme preferences from localStorage
 * (key: ipenovel_reader_preferences), scoped to the reader content only.
 */
export function useReaderPreferences() {
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadPreferences);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // localStorage unavailable (private browsing / quota) - preferences
      // just won't persist across sessions, which is a safe degradation.
    }
  }, [preferences]);

  const updatePreference = useCallback(<K extends keyof ReaderPreferences>(key: K, value: ReaderPreferences[K]) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences({ ...DEFAULT_READER_PREFERENCES });
  }, []);

  return { preferences, updatePreference, resetPreferences };
}

export function getFontFamilyStack(fontFamily: ReaderFontFamily): string | undefined {
  return FONT_FAMILY_OPTIONS.find((option) => option.value === fontFamily)?.stack;
}
