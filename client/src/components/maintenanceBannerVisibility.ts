/**
 * Pure, DOM-free decision: should the maintenance announcement banner
 * render for a given wouter `location`, given the config's `enabled`
 * flag?
 *
 * Hidden ONLY on the Admin section (`/admin`, `/admin/*`) - an internal
 * tool, not a page a reading customer needs the maintenance notice on.
 * Deliberately does NOT reuse shouldHideGlobalNavbar (navbarVisibility.ts)
 * here, even though the two lists used to be identical: the storefront
 * Navbar also hides on Reader (`/read/*`) because Reader renders its own
 * top chrome, but the banner must still show there - readers need the
 * maintenance notice too. See MaintenanceAnnouncementBanner.tsx's own
 * doc comment and ReaderPage.module.css for how the two coexist without
 * the banner overlapping Reader's own sticky header/Focus-Mode chrome:
 * the banner publishes its rendered height as a CSS custom property
 * (--maintenance-banner-height) that ReaderPage.module.css/ReaderPage.tsx
 * read to reserve/offset exactly that much space, so no route-hiding is
 * needed there at all.
 */
export function shouldShowMaintenanceBanner(location: string, enabled: boolean): boolean {
  if (!enabled) return false;
  if (location === "/admin" || location.startsWith("/admin/")) return false;
  return true;
}
