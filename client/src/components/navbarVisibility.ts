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
