import { describe, expect, it } from "vitest";
import {
  PUBLIC_THEME_STORAGE_KEY,
  parsePublicThemePreference,
  preferenceFromStorageEvent,
  readBrowserPublicThemePreference,
  readPublicThemePreference,
  resolvePublicTheme,
  writeBrowserPublicThemePreference,
  writePublicThemePreference,
} from "./publicTheme";

describe("parsePublicThemePreference", () => {
  it("returns light for null", () => {
    expect(parsePublicThemePreference(null)).toBe("light");
  });

  it('returns dark for "dark"', () => {
    expect(parsePublicThemePreference("dark")).toBe("dark");
  });

  it('returns system for "system"', () => {
    expect(parsePublicThemePreference("system")).toBe("system");
  });

  it('returns light for "sepia"', () => {
    expect(parsePublicThemePreference("sepia")).toBe("light");
  });
});

describe("resolvePublicTheme", () => {
  it("returns dark for system when prefersDark is true", () => {
    expect(resolvePublicTheme("system", true)).toBe("dark");
  });

  it("returns light for system when prefersDark is false", () => {
    expect(resolvePublicTheme("system", false)).toBe("light");
  });

  it("returns light for light even when prefersDark is true", () => {
    expect(resolvePublicTheme("light", true)).toBe("light");
  });
});

describe("preferenceFromStorageEvent", () => {
  it("returns dark for the public storage key", () => {
    expect(
      preferenceFromStorageEvent({ key: PUBLIC_THEME_STORAGE_KEY, newValue: "dark" }),
    ).toBe("dark");
  });

  it("returns null for unrelated keys", () => {
    expect(preferenceFromStorageEvent({ key: "theme", newValue: "dark" })).toBe(null);
  });

  it("returns light when the public key is removed", () => {
    expect(
      preferenceFromStorageEvent({ key: PUBLIC_THEME_STORAGE_KEY, newValue: null }),
    ).toBe("light");
  });

  it("returns light when storage is cleared", () => {
    expect(preferenceFromStorageEvent({ key: null, newValue: null })).toBe("light");
  });
});

describe("writePublicThemePreference", () => {
  it("does not throw when setItem throws", () => {
    const storage = {
      data: {} as Record<string, string>,
      getItem(key: string) {
        return this.data[key] ?? null;
      },
      setItem() {
        throw new Error("quota exceeded");
      },
      removeItem(key: string) {
        delete this.data[key];
      },
      clear() {
        this.data = {};
      },
      key: () => null,
      length: 0,
    } satisfies Storage;

    expect(() => writePublicThemePreference(storage, "dark")).not.toThrow();
  });

  it("does not modify ipenovel_reader_preferences when writing the public theme", () => {
    const storage = {
      data: {
        ipenovel_reader_preferences: '{"theme":"sepia"}',
      } as Record<string, string>,
      getItem(key: string) {
        return this.data[key] ?? null;
      },
      setItem(key: string, value: string) {
        this.data[key] = value;
      },
      removeItem(key: string) {
        delete this.data[key];
      },
      clear() {
        this.data = {};
      },
      key: () => null,
      length: 0,
    } satisfies Storage;

    writePublicThemePreference(storage, "dark");
    expect(storage.data.ipenovel_reader_preferences).toBe('{"theme":"sepia"}');
    expect(storage.data[PUBLIC_THEME_STORAGE_KEY]).toBe("dark");
  });
});

describe("readPublicThemePreference", () => {
  it("returns light when storage is missing", () => {
    expect(readPublicThemePreference(undefined)).toBe("light");
  });

  it("returns light when touching storage throws", () => {
    expect(readBrowserPublicThemePreference(() => {
      throw new Error("storage blocked");
    })).toBe("light");
    expect(() => writeBrowserPublicThemePreference(() => {
      throw new Error("storage blocked");
    }, "dark")).not.toThrow();
  });
});
