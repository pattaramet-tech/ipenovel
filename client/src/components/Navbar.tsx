import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { BookOpen, ShoppingCart, LogOut, Menu, X, Settings, Heart, Trophy, User as UserIcon, LifeBuoy } from "lucide-react";
import { useState } from "react";
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

  const navLinks = [
    { label: t("nav.browse"), href: "/novels", icon: BookOpen },
    { label: t("nav.myNovels"), href: "/my-novels", auth: true, icon: BookOpen },
    { label: t("nav.orders"), href: "/orders", auth: true, icon: ShoppingCart },
    { label: t("nav.wallet"), href: "/wallet", auth: true, icon: Heart },
    { label: t("nav.points"), href: "/points", auth: true, icon: Heart },
    { label: "Football Votes", href: "/sports-votes", auth: true, icon: Trophy },
  ];

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
            {navLinks.map((link) => {
              if (link.auth && !isAuthenticated) return null;
              const Icon = link.icon;
              return (
                <button
                  key={link.href}
                  onClick={() => navigate(link.href)}
                  className="ipe-nav-link flex items-center gap-2 px-4 py-2 rounded-full transition text-sm whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  {link.label}
                </button>
              );
            })}
            
            {/* Admin Link Desktop */}
            {user?.role === "admin" && (
              <button
                onClick={() => navigate("/admin")}
                className="ipe-nav-link flex items-center gap-2 px-4 py-2 rounded-full transition text-sm whitespace-nowrap"
              >
                <Settings className="w-4 h-4" />
                {t("nav.admin")}
              </button>
            )}
          </div>

          {/* Right Section - Desktop */}
          <div className="hidden lg:flex items-center gap-3">
            <LanguageSwitcher />
            
            <button
              onClick={() => navigate("/cart")}
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
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600 px-3 py-2 rounded-full bg-slate-50">
                  {user?.name?.split(" ")[0]}
                </span>
                <button
                  onClick={() => navigate("/profile")}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium transition text-sm"
                >
                  <UserIcon className="w-4 h-4" />
                  {t("nav.profile")}
                </button>
                {showAccountRecoveryNavItem && (
                  <button
                    onClick={() => navigate(ACCOUNT_RECOVERY_NAV_HREF)}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium transition text-sm"
                  >
                    <LifeBuoy className="w-4 h-4" />
                    {t("nav.accountRecovery")}
                  </button>
                )}
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium transition text-sm"
                >
                  <LogOut className="w-4 h-4" />
                  {t("nav.logout")}
                </button>
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
          <div id="ipe-mobile-navigation" className="lg:hidden pb-4 border-t border-slate-100 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex flex-col gap-2 pt-4">
              {/* Mobile Nav Links */}
              {navLinks.map((link) => {
                if (link.auth && !isAuthenticated) return null;
                const Icon = link.icon;
                return (
                  <button
                    key={link.href}
                    onClick={() => {
                      navigate(link.href);
                      setMobileMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 font-medium transition text-sm"
                  >
                    <Icon className="w-4 h-4" />
                    {link.label}
                  </button>
                );
              })}
              
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
