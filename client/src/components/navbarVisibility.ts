/**
 * Whether the global storefront Navbar must be hidden for a given wouter
 * `location`. Pure and DOM-free so it can be unit-tested directly (this
 * repo has no component/DOM test harness).
 *
 * Two sections own their own top-level navigation and must never render
 * alongside the storefront Navbar:
 *   - /admin and every /admin/* route (including /admin/login) - AdminLayout
 *     (and AdminLoginPage for /admin/login) already render the Admin top
 *     bar/sidebar. Stacking the storefront Navbar on top of it visually
 *     covers the Admin top bar and its "Admin Menu" trigger on narrow
 *     viewports (storefront Navbar is sticky top-0 z-50; the Admin mobile
 *     top bar is fixed top-0 z-40 lg:hidden).
 *   - /read/* - ReaderPage renders its own sticky header (back button,
 *     episode title, font/theme/TOC controls); see Navbar.tsx's prior
 *     inline comment for the stacking-sticky-headers issue this avoided.
 */
export function shouldHideGlobalNavbar(location: string): boolean {
  if (location.startsWith("/read/")) return true;
  if (location === "/admin" || location.startsWith("/admin/")) return true;
  return false;
}

/** The single route the Navbar's "กู้คืนบัญชีเดิม" (Account Recovery) item
 *  links to - kept as one exported constant so Navbar.tsx and this file's
 *  own test never risk drifting into two different literal path strings. */
export const ACCOUNT_RECOVERY_NAV_HREF = "/account/recovery";

/**
 * Whether the Navbar's "กู้คืนบัญชีเดิม" (Account Recovery) menu item
 * should render - signed-in users only (anonymous visitors have no account
 * to recover, and the server itself would reject a request from an
 * unauthenticated caller anyway - this is a discoverability affordance,
 * never the security boundary). Pure and DOM-free for the same reason as
 * shouldHideGlobalNavbar above - this repo has no component/DOM test
 * harness, so Navbar.tsx wires its conditional render to this function
 * rather than an inline `isAuthenticated` check that couldn't be
 * unit-tested on its own.
 *
 * Intentionally does NOT depend on the user's role - the storefront
 * Navbar itself never renders on any /admin/* route (see
 * shouldHideGlobalNavbar above), so "not shown in the Admin menu" is
 * already true by construction; an admin who is simply browsing the
 * storefront while signed in sees the same authenticated-user items
 * (profile/logout) as anyone else, and this item is no different.
 */
export function shouldShowAccountRecoveryNavItem(isAuthenticated: boolean): boolean {
  return isAuthenticated;
}
