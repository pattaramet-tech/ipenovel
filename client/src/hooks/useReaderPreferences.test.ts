import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_PREFERENCES,
  parseStoredReaderPreferences,
} from "./useReaderPreferences";

describe("parseStoredReaderPreferences", () => {
  it("returns the defaults when there's no stored value (null)", () => {
    expect(parseStoredReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
  });

  it("returns the defaults for corrupted JSON", () => {
    expect(parseStoredReaderPreferences("{not valid json")).toEqual(DEFAULT_READER_PREFERENCES);
  });

  it("returns the defaults for a JSON value that isn't an object (array/string/number/null)", () => {
    expect(parseStoredReaderPreferences("[1,2,3]")).toEqual(DEFAULT_READER_PREFERENCES);
    expect(parseStoredReaderPreferences('"just a string"')).toEqual(DEFAULT_READER_PREFERENCES);
    expect(parseStoredReaderPreferences("42")).toEqual(DEFAULT_READER_PREFERENCES);
    expect(parseStoredReaderPreferences("null")).toEqual(DEFAULT_READER_PREFERENCES);
  });

  it("defaults focusMode to false for a legacy stored object that predates it", () => {
    const legacy = JSON.stringify({
      fontSize: 20,
      fontFamily: "sarabun",
      lineHeight: 2.0,
      paragraphSpacing: 24,
      theme: "dark",
      // no focusMode key at all
    });
    const result = parseStoredReaderPreferences(legacy);
    expect(result.focusMode).toBe(false);
    // The rest of the legacy data is still honored - a missing focusMode
    // key must not fall back to the WHOLE default object.
    expect(result.fontSize).toBe(20);
    expect(result.theme).toBe("dark");
  });

  it("loads focusMode: true when it was actually stored as true", () => {
    const result = parseStoredReaderPreferences(JSON.stringify({ focusMode: true }));
    expect(result.focusMode).toBe(true);
  });

  it("falls back to false when focusMode is stored as the wrong type (string)", () => {
    const result = parseStoredReaderPreferences(JSON.stringify({ focusMode: "true" }));
    expect(result.focusMode).toBe(false);
  });

  it("falls back to false when focusMode is stored as the wrong type (number)", () => {
    const result = parseStoredReaderPreferences(JSON.stringify({ focusMode: 1 }));
    expect(result.focusMode).toBe(false);
  });

  it("still clamps fontSize/lineHeight/paragraphSpacing to their min/max ranges", () => {
    const result = parseStoredReaderPreferences(
      JSON.stringify({ fontSize: 999, lineHeight: 0, paragraphSpacing: -5 })
    );
    expect(result.fontSize).toBe(28); // FONT_SIZE_MAX
    expect(result.lineHeight).toBe(1.4); // LINE_HEIGHT_MIN
    expect(result.paragraphSpacing).toBe(8); // PARAGRAPH_SPACING_MIN
  });

  it("falls back to the default theme/fontFamily for an invalid value", () => {
    const result = parseStoredReaderPreferences(
      JSON.stringify({ theme: "neon", fontFamily: "comic-sans" })
    );
    expect(result.theme).toBe(DEFAULT_READER_PREFERENCES.theme);
    expect(result.fontFamily).toBe(DEFAULT_READER_PREFERENCES.fontFamily);
  });

  it("loading a preference object with valid font/theme fields never drops focusMode", () => {
    const stored = JSON.stringify({
      fontSize: 22,
      fontFamily: "kanit",
      lineHeight: 2.2,
      paragraphSpacing: 20,
      theme: "sepia",
      focusMode: true,
    });
    const result = parseStoredReaderPreferences(stored);
    expect(result).toEqual({
      fontSize: 22,
      fontFamily: "kanit",
      lineHeight: 2.2,
      paragraphSpacing: 20,
      theme: "sepia",
      focusMode: true,
    });
  });

  it("never returns the same object reference as DEFAULT_READER_PREFERENCES", () => {
    expect(parseStoredReaderPreferences(null)).not.toBe(DEFAULT_READER_PREFERENCES);
    expect(parseStoredReaderPreferences("{bad json")).not.toBe(DEFAULT_READER_PREFERENCES);
    expect(parseStoredReaderPreferences(JSON.stringify({ focusMode: true }))).not.toBe(
      DEFAULT_READER_PREFERENCES
    );
  });

  it("never mutates DEFAULT_READER_PREFERENCES across repeated calls", () => {
    const snapshot = { ...DEFAULT_READER_PREFERENCES };
    parseStoredReaderPreferences(null);
    parseStoredReaderPreferences(JSON.stringify({ focusMode: true, fontSize: 26 }));
    parseStoredReaderPreferences("garbage");
    expect(DEFAULT_READER_PREFERENCES).toEqual(snapshot);
  });
});
