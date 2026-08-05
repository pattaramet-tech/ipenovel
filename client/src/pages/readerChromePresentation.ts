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
  const focusEligible = input.focusMode && input.canRead && input.hasReadableContent;

  // The reader menu dropdown, Settings panel, and TOC drawer all live
  // inside/above the header's own DOM (the menu) or need the header's
  // controls to reopen them (Settings/TOC) - so while any of them is open,
  // the header must temporarily reappear rather than stay collapsed behind
  // an overlay. This doesn't touch the `focusMode` preference itself: once
  // the overlay closes, the header goes back to being hidden exactly as
  // Focus Mode already had it, with no separate state to reconcile.
  const overlayOpen = input.readerMenuOpen || input.readerSettingsOpen || input.tocOpen;

  const focusActive = focusEligible && !overlayOpen;

  return {
    hideHeader: focusActive,
    showRestoreButton: focusActive,
  };
}
