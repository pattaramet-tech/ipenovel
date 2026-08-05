import { describe, expect, it } from "vitest";
import { deriveReaderChromeState, type ReaderChromeInput } from "./readerChromePresentation";

const baseInput: ReaderChromeInput = {
  focusMode: true,
  canRead: true,
  hasReadableContent: true,
  readerMenuOpen: false,
  readerSettingsOpen: false,
  tocOpen: false,
};

describe("deriveReaderChromeState", () => {
  it("shows the header and hides the restore button when Focus Mode is off", () => {
    expect(deriveReaderChromeState({ ...baseInput, focusMode: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("shows the header when Focus Mode is on but the reader can't actually read (locked/purchase-prompt state)", () => {
    expect(deriveReaderChromeState({ ...baseInput, canRead: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("shows the header when Focus Mode is on but there's no readable content (empty package, legacy file-only episode)", () => {
    expect(deriveReaderChromeState({ ...baseInput, hasReadableContent: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("hides the header and shows the restore button when Focus Mode is on, content is readable, and no overlay is open", () => {
    expect(deriveReaderChromeState(baseInput)).toEqual({
      hideHeader: true,
      showRestoreButton: true,
    });
  });

  it("brings the header back and hides the restore button while the reader options menu is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, readerMenuOpen: true })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("brings the header back and hides the restore button while the Settings panel is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, readerSettingsOpen: true })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("brings the header back and hides the restore button while the Table of Contents drawer is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, tocOpen: true })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("brings the header back when multiple overlays are (impossibly, but defensively) reported open at once", () => {
    expect(
      deriveReaderChromeState({ ...baseInput, readerMenuOpen: true, tocOpen: true })
    ).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("goes back to hiding the header (Focus Mode's own preference, unchanged) once the overlay that was open closes", () => {
    const withOverlayOpen = deriveReaderChromeState({ ...baseInput, readerSettingsOpen: true });
    expect(withOverlayOpen).toEqual({ hideHeader: false, showRestoreButton: false });

    const afterOverlayCloses = deriveReaderChromeState({ ...baseInput, readerSettingsOpen: false });
    expect(afterOverlayCloses).toEqual({ hideHeader: true, showRestoreButton: true });
  });

  it("never hides the header when Focus Mode is off even if every other flag is true", () => {
    expect(
      deriveReaderChromeState({
        focusMode: false,
        canRead: true,
        hasReadableContent: true,
        readerMenuOpen: true,
        readerSettingsOpen: true,
        tocOpen: true,
      })
    ).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });
});
