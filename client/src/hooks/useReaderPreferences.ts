import { useCallback, useEffect, useState } from "react";

export type ReaderFontFamily = "default" | "sarabun" | "notoSansThai" | "prompt" | "kanit" | "system";
export type ReaderTheme = "light" | "dark" | "sepia";

export interface ReaderPreferences {
  fontSize: number;
  fontFamily: ReaderFontFamily;
  lineHeight: number;
  paragraphSpacing: number;
  theme: ReaderTheme;
}

const STORAGE_KEY = "ipenovel_reader_preferences";

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 18,
  fontFamily: "default",
  lineHeight: 1.8,
  paragraphSpacing: 16,
  theme: "light",
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

function loadPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return DEFAULT_READER_PREFERENCES;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_READER_PREFERENCES;

    const parsed = JSON.parse(raw);
    return {
      fontSize: typeof parsed.fontSize === "number"
        ? clamp(parsed.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX)
        : DEFAULT_READER_PREFERENCES.fontSize,
      fontFamily: isValidFontFamily(parsed.fontFamily) ? parsed.fontFamily : DEFAULT_READER_PREFERENCES.fontFamily,
      lineHeight: typeof parsed.lineHeight === "number"
        ? clamp(parsed.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)
        : DEFAULT_READER_PREFERENCES.lineHeight,
      paragraphSpacing: typeof parsed.paragraphSpacing === "number"
        ? clamp(parsed.paragraphSpacing, PARAGRAPH_SPACING_MIN, PARAGRAPH_SPACING_MAX)
        : DEFAULT_READER_PREFERENCES.paragraphSpacing,
      theme: isValidTheme(parsed.theme) ? parsed.theme : DEFAULT_READER_PREFERENCES.theme,
    };
  } catch {
    return DEFAULT_READER_PREFERENCES;
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
    setPreferences(DEFAULT_READER_PREFERENCES);
  }, []);

  return { preferences, updatePreference, resetPreferences };
}

export function getFontFamilyStack(fontFamily: ReaderFontFamily): string | undefined {
  return FONT_FAMILY_OPTIONS.find((option) => option.value === fontFamily)?.stack;
}
