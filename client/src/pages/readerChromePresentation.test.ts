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
  it("hides the header and shows the restore button when Focus Mode is on, content is readable, and no overlay is open", () => {
    expect(deriveReaderChromeState(baseInput)).toEqual({
      hideHeader: true,
      showRestoreButton: true,
    });
  });

  it("never hides the header when Focus Mode is off, regardless of everything else", () => {
    expect(deriveReaderChromeState({ ...baseInput, focusMode: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("never hides the header when the reader can't actually read (locked/purchase-prompt state)", () => {
    expect(deriveReaderChromeState({ ...baseInput, canRead: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("never hides the header when there's no readable content (empty package, legacy file-only episode)", () => {
    expect(deriveReaderChromeState({ ...baseInput, hasReadableContent: false })).toEqual({
      hideHeader: false,
      showRestoreButton: false,
    });
  });

  it("keeps the header hidden but suppresses the restore button while the reader options menu is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, readerMenuOpen: true })).toEqual({
      hideHeader: true,
      showRestoreButton: false,
    });
  });

  it("keeps the header hidden but suppresses the restore button while the Settings panel is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, readerSettingsOpen: true })).toEqual({
      hideHeader: true,
      showRestoreButton: false,
    });
  });

  it("keeps the header hidden but suppresses the restore button while the Table of Contents drawer is open", () => {
    expect(deriveReaderChromeState({ ...baseInput, tocOpen: true })).toEqual({
      hideHeader: true,
      showRestoreButton: false,
    });
  });

  it("suppresses the restore button when multiple overlays are (impossibly, but defensively) reported open at once", () => {
    expect(
      deriveReaderChromeState({ ...baseInput, readerMenuOpen: true, tocOpen: true })
    ).toEqual({
      hideHeader: true,
      showRestoreButton: false,
    });
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
