/**
 * Derives the Reader page's "chrome" visibility (its own sticky header, and
 * the floating restore button that appears in its place) from Focus Mode +
 * the page's current state. Pure and DOM-free so it can be unit-tested
 * directly (this repo has no component/DOM test harness) - see
 * navbarVisibility.ts / accountRecoveryPresentation.ts for the same pattern.
 */
export type ReaderChromeState = {
  hideHeader: boolean;
  showRestoreButton: boolean;
};

export type ReaderChromeInput = {
  focusMode: boolean;
  canRead: boolean;
  hasReadableContent: boolean;
  readerMenuOpen: boolean;
  readerSettingsOpen: boolean;
  tocOpen: boolean;
};

export function deriveReaderChromeState(input: ReaderChromeInput): ReaderChromeState {
  // Focus Mode only ever collapses the header while there's actual content
  // being read - never on the locked/purchase-prompt/no-content states,
  // where the header's back button and toolbar are the only way out.
  const focusActive = input.focusMode && input.canRead && input.hasReadableContent;

  // Any overlay (reader menu dropdown, Settings panel, TOC drawer) already
  // covers the header visually - but the header staying `inert` either way
  // is fine, so it deliberately does NOT re-expand hideHeader here (that
  // would make the header pop back in and out on every overlay open/close,
  // which is jarring). The floating restore button, however, is a separate
  // fixed-position element that would otherwise poke out from under a
  // translucent overlay backdrop and be reachable by keyboard while hidden
  // behind it - so it's suppressed whenever an overlay is open.
  const overlayOpen = input.readerMenuOpen || input.readerSettingsOpen || input.tocOpen;

  return {
    hideHeader: focusActive,
    showRestoreButton: focusActive && !overlayOpen,
  };
}
