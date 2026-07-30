// Pure logic backing UpgradeLoginPage - kept out of the component itself
// (same pattern as profileGoogleConnectStatus.ts/checkoutOutcome.ts
// elsewhere in this codebase) so it's directly testable without a DOM
// harness (this repo has none - no @testing-library/jsdom installed).

/**
 * VITE_SUPPORT_URL is the only source for the "ติดต่อฝ่ายช่วยเหลือ" button's
 * link - there is no existing, already-wired-up support channel anywhere
 * else in this codebase (confirmed by inspection - AdminSettingsPage's
 * "contactEmail" field is local, unsaved UI state, never read by any other
 * page). Never a guessed/hardcoded URL: an empty/whitespace-only value
 * means the button must not render at all, rather than linking to a
 * fabricated address.
 */
export function resolveSupportUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
