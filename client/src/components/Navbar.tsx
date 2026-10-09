import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { BookOpen, ShoppingCart, LogOut, Menu, X, Settings, Heart, Trophy, User as UserIcon, LifeBuoy, ChevronDown, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getLoginUrl } from "@/const";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { ACCOUNT_RECOVERY_NAV_HREF, shouldHideGlobalNavbar, shouldShowAccountRecoveryNavItem } from "./navbarVisibility";
import "../styles/public-storefront.css";

export default function Navbar() {
  const { user, logout, isAuthenticated } = useAuth();
  const { t, language } = useLanguage();
  const [location, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const mobileToggleRef = useRef<HTMLButtonElement | null>(null);
  const mobilePanelRef = useRef<HTMLDivElement | null>(null);

  // IPE-069R5F (P2-02): crossing the lg breakpoint closes every navigation
  // layer (mobile menu + both dropdowns) so a resize never leaves a stale
  // mobile menu in the DOM next to desktop dropdowns, and the variants can
  // never render duplicate ids at the same time. The listener is removed on
  // unmount - nothing leaks.
  const [isDesktopViewport, setIsDesktopViewport] = useState(
    () => window.matchMedia("(min-width: 1024px)").matches
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      setIsDesktopViewport(event.matches);
      setMobileMenuOpen(false);
      setMoreOpen(false);
      setAccountOpen(false);
    };
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  // Reader (/read/*) and the entire Admin section (/admin, /admin/*) own
  // their own top-level navigation - see navbarVisibility.ts. Computed
  // before the early return below so the hidden-navbar branch never fires
  // a cart query it doesn't render, without skipping any hook call.
  const navbarHidden = shouldHideGlobalNavbar(location);
  const showAccountRecoveryNavItem = shouldShowAccountRecoveryNavItem(isAuthenticated);

  // Get cart count - not needed at all when the navbar itself won't render.
  const { data: cartData } = trpc.cart.get.useQuery(undefined, {
    enabled: isAuthenticated && !navbarHidden,
  });
  const cartCount = cartData?.items?.length || 0;

  // IPE-069R5A: dismiss every dropdown + the mobile menu on Escape, on any
  // outside pointer press, and when the route changes - focus returns to the
  // toggle that opened the layer. Synchronous with render via refs so a
  // route change can never leave a stale dropdown open.
  useEffect(() => {
    setMoreOpen(false);
    setAccountOpen(false);
    setMobileMenuOpen(false);
  }, [location]);

  useEffect(() => {
    if (!moreOpen && !accountOpen && !mobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (moreOpen) {
        setMoreOpen(false);
        moreRef.current?.querySelector<HTMLButtonElement>("[data-ipe-nav-toggle]")?.focus();
      }
      if (accountOpen) {
        setAccountOpen(false);
        accountRef.current?.querySelector<HTMLButtonElement>("[data-ipe-nav-toggle]")?.focus();
      }
      if (mobileMenuOpen) {
        setMobileMenuOpen(false);
        mobileToggleRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (moreOpen && !moreRef.current?.contains(target)) setMoreOpen(false);
      if (accountOpen && !accountRef.current?.contains(target)) setAccountOpen(false);
      if (mobileMenuOpen &&
          !mobileToggleRef.current?.contains(target) &&
          !mobilePanelRef.current?.contains(target)) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [moreOpen, accountOpen, mobileMenuOpen]);

  // The Reader page has its own sticky header (back button, title, font/theme/TOC
  // controls) and the Admin section owns its own top bar/sidebar (AdminLayout) -
  // rendering the storefront Navbar on top of either stacks/overlaps two headers
  // (on Reader, two `position: sticky; top: 0` bars fight for the same space; on
  // Admin routes below 1024px, the Navbar's `sticky top-0 z-50` visually covers
  // AdminLayout's `fixed top-0 z-40` mobile top bar and its "Admin Menu" button).
  // Both own their navigation entirely - the language switcher is still reachable
  // from Reader's own options menu.
  if (navbarHidden) {
    return null;
  }

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  const isActive = (href: string) =>
    location === href || (href !== "/" && location.startsWith(href + "/"));

  // IPE-069R5A: Primary = the daily-use destinations. Secondary destinations
  // move into the "More" dropdown (auth-gated exactly like before - no route
  // or permission is added or removed).
  const primaryLinks = [
    { label: t("nav.browse"), href: "/novels", icon: BookOpen },
    { label: t("nav.myNovels"), href: "/my-novels", auth: true, icon: BookOpen },
    { label: t("nav.orders"), href: "/orders", auth: true, icon: ShoppingCart },
  ];
  const moreLinks = [
    { label: t("nav.wallet"), href: "/wallet", auth: true, icon: Wallet },
    { label: t("nav.points"), href: "/points", auth: true, icon: Heart },
    { label: "Football Votes", href: "/sports-votes", auth: true, icon: Trophy },
  ];
  const visibleMoreLinks = moreLinks.filter((link) => !link.auth || isAuthenticated);
  // IPE-069R5F (P2-01): dropdown toggles show the active state whenever the
  // current route matches any destination INSIDE their dropdown.
  const moreChildActive = visibleMoreLinks.some((link) => isActive(link.href));
  const accountItems = [
    { label: t("nav.profile"), href: "/profile", icon: UserIcon },
    ...(showAccountRecoveryNavItem
      ? [{ label: t("nav.accountRecovery"), href: ACCOUNT_RECOVERY_NAV_HREF, icon: LifeBuoy }]
      : []),
    ...(user?.role === "admin" ? [{ label: t("nav.admin"), href: "/admin", icon: Settings }] : []),
  ];
  const accountChildActive = accountItems.some((item) => isActive(item.href));

  const renderNavLink = (link: { label: string; href: string; icon: typeof BookOpen }) => {
    const Icon = link.icon;
    const active = isActive(link.href);
    return (
      <button
        key={link.href}
        onClick={() => navigate(link.href)}
        aria-current={active ? "page" : undefined}
        className={`ipe-nav-link flex items-center gap-2 px-4 py-2 rounded-full transition text-sm whitespace-nowrap ${active ? "ipe-nav-link-active" : ""}`}
      >
        <Icon className="w-4 h-4" />
        {link.label}
      </button>
    );
  };

  const dropdownItemClass =
    "ipe-nav-dropdown-item flex items-center gap-2 w-full text-left px-3 py-2 text-sm transition";

  const renderMoreMenu = (variant: "desktop" | "mobile") => (
    <div
      id={variant === "desktop" ? "ipe-more-menu" : "ipe-more-menu-mobile"}
      aria-label={t("nav.more")}
      className={
        variant === "desktop"
          ? "ipe-nav-dropdown absolute right-0 top-full mt-2 min-w-[200px] rounded-xl p-1 z-50"
          : "ipe-nav-dropdown rounded-xl p-1"
      }
    >
      {visibleMoreLinks.map((link) => {
        const Icon = link.icon;
        const active = isActive(link.href);
        return (
          <button
            key={link.href}
                        aria-current={active ? "page" : undefined}
            onClick={() => {
              navigate(link.href);
              setMoreOpen(false);
              if (variant === "mobile") setMobileMenuOpen(false);
            }}
            className={`${dropdownItemClass} ${active ? "ipe-nav-link-active" : ""}`}
          >
            <Icon className="w-4 h-4" />
            {link.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <nav aria-label="Public navigation" className="ipe-public-nav sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Logo - Mobile First */}
          <button
            type="button"
            aria-label={language === "th" ? "Ipenovel — หน้าแรก" : "Ipenovel — home"}
            className="flex items-center gap-2 cursor-pointer flex-shrink-0"
            onClick={() => navigate("/")}
          >
            <span className="ipe-brand-mark w-8 h-8 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-white" />
            </span>
            <span className="ipe-brand-name text-base sm:text-lg hidden sm:inline">Ipenovel</span>
          </button>

          {/* Desktop Navigation - Hidden on Mobile */}
          <div className="hidden lg:flex items-center gap-2 flex-1 ml-8">
            {primaryLinks.map((link) => {
              if (link.auth && !isAuthenticated) return null;
              return renderNavLink(link);
            })}

            {/* More dropdown - secondary destinations (auth-gated as before) */}
            {visibleMoreLinks.length > 0 && (
              <div ref={moreRef} className="relative">
                <button
                  data-ipe-nav-toggle
                  aria-controls="ipe-more-menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                  className={`ipe-nav-link flex items-center gap-1 px-4 py-2 rounded-full transition text-sm whitespace-nowrap ${moreOpen || moreChildActive ? "ipe-nav-link-active" : ""}`}
                >
                  {t("nav.more")}
                  <ChevronDown className={`w-4 h-4 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
                </button>
                {moreOpen && isDesktopViewport && renderMoreMenu("desktop")}
              </div>
            )}
          </div>

          {/* Right Section - Desktop */}
          <div className="hidden lg:flex items-center gap-3">
            <LanguageSwitcher />

            <button
              onClick={() => navigate("/cart")}
              aria-label={`${t("nav.cart")}${cartCount > 0 ? ` (${cartCount})` : ""}`}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium transition text-sm relative"
            >
              <ShoppingCart className="w-4 h-4" />
              {t("nav.cart")}
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {cartCount}
                </span>
              )}
            </button>

            {isAuthenticated ? (
              <div ref={accountRef} className="relative">
                <button
                  data-ipe-nav-toggle
                  aria-controls="ipe-account-menu"
                  aria-expanded={accountOpen}
                  onClick={() => setAccountOpen((open) => !open)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-full text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium transition text-sm ${accountOpen || accountChildActive ? "ipe-nav-link-active" : ""}`}
                >
                  <span className="ipe-account-avatar w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold">
                    {(user?.name?.trim()?.[0] ?? "?").toUpperCase()}
                  </span>
                  <span className="max-w-[120px] truncate">{user?.name?.split(" ")[0]}</span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${accountOpen ? "rotate-180" : ""}`} />
                </button>
                {accountOpen && (
                  <div
                    id="ipe-account-menu"
                    aria-label={t("nav.account")}
                    className="ipe-nav-dropdown absolute right-0 top-full mt-2 min-w-[220px] rounded-xl p-1 z-50"
                  >
                    <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100 mb-1">
                      {t("nav.signedInAs")} <span className="font-semibold">{user?.name}</span>
                    </div>
                    {accountItems.map((item) => {
                      const Icon = item.icon;
                      const active = isActive(item.href);
                      return (
                        <button
                          key={item.href}
                                                    aria-current={active ? "page" : undefined}
                          onClick={() => {
                            navigate(item.href);
                            setAccountOpen(false);
                          }}
                          className={`${dropdownItemClass} ${active ? "ipe-nav-link-active" : ""}`}
                        >
                          <Icon className="w-4 h-4" />
                          {item.label}
                        </button>
                      );
                    })}
                    <div className="border-t border-slate-100 my-1" />
                    <button
                                            onClick={() => {
                        setAccountOpen(false);
                        void handleLogout();
                      }}
                      className={dropdownItemClass}
                    >
                      <LogOut className="w-4 h-4" />
                      {t("nav.logout")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Button size="sm" asChild className="ipe-nav-cta rounded-full">
                <a href={getLoginUrl()}>{t("nav.login")}</a>
              </Button>
            )}
          </div>

          {/* Mobile Right Section */}
          <div className="lg:hidden flex items-center gap-2">
            <LanguageSwitcher />

            <button
              type="button"
              aria-label={t("nav.cart")}
              onClick={() => navigate("/cart")}
              className="ipe-nav-link p-2 rounded-full transition relative"
            >
              <ShoppingCart className="w-5 h-5 text-slate-600" />
              {cartCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {cartCount}
                </span>
              )}
            </button>

            {/* Mobile Menu Button */}
            <button
              ref={mobileToggleRef}
              type="button"
              className="ipe-nav-link p-2 rounded-full transition"
              aria-label={mobileMenuOpen ? (language === "th" ? "ปิดเมนู" : "Close menu") : (language === "th" ? "เปิดเมนู" : "Open menu")}
              aria-expanded={mobileMenuOpen}
              aria-controls="ipe-mobile-navigation"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5 text-slate-600" />
              ) : (
                <Menu className="w-5 h-5 text-slate-600" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Navigation Menu */}
        {mobileMenuOpen && (
          <div ref={mobilePanelRef} id="ipe-mobile-navigation" className="lg:hidden pb-4 border-t border-slate-100 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex flex-col gap-2 pt-4">
              {/* Mobile Nav Links */}
              {primaryLinks.map((link) => {
                if (link.auth && !isAuthenticated) return null;
                const Icon = link.icon;
                return (
                  <button
                    key={link.href}
                    aria-current={isActive(link.href) ? "page" : undefined}
                    onClick={() => {
                      navigate(link.href);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm ${isActive(link.href) ? "ipe-nav-link-active" : ""}`}
                  >
                    <Icon className="w-4 h-4" />
                    {link.label}
                  </button>
                );
              })}

              {/* Mobile More group - secondary destinations, same auth gating */}
              {visibleMoreLinks.length > 0 && (
                <>
                  <div className="px-4 pt-2 pb-1 text-xs uppercase tracking-wide text-slate-400">
                    {t("nav.more")}
                  </div>
                  {renderMoreMenu("mobile")}
                </>
              )}

              {/* Admin Link Mobile */}
              {user?.role === "admin" && (
                <button
                  onClick={() => {
                    navigate("/admin");
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm"
                >
                  <Settings className="w-4 h-4" />
                  {t("nav.admin")}
                </button>
              )}

              {/* Divider */}
              <div className="border-t border-slate-100 my-2" />

              {/* Auth Section Mobile */}
              {isAuthenticated ? (
                <div className="flex flex-col gap-2">
                  <div className="px-4 py-3 text-sm text-slate-600">
                    {t("nav.signedInAs")} <span className="font-semibold">{user?.name}</span>
                  </div>
                  <button
                    onClick={() => {
                      navigate("/profile");
                      setMobileMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm"
                  >
                    <UserIcon className="w-4 h-4" />
                    {t("nav.profile")}
                  </button>
                  {showAccountRecoveryNavItem && (
                    <button
                      onClick={() => {
                        navigate(ACCOUNT_RECOVERY_NAV_HREF);
                        setMobileMenuOpen(false);
                      }}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm"
                    >
                      <LifeBuoy className="w-4 h-4" />
                      {t("nav.accountRecovery")}
                    </button>
                  )}
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm"
                  >
                    <LogOut className="w-4 h-4" />
                    {t("nav.logout")}
                  </button>
                </div>
              ) : (
                <Button asChild className="ipe-nav-cta rounded-full w-full">
                  <a href={getLoginUrl()}>{t("nav.login")}</a>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}