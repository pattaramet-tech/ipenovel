import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { resolveAdminAccessState } from "@/_core/hooks/adminAccess";
import { resolveUnauthorizedRedirectTarget } from "@/_core/hooks/unauthorizedRedirect";
import { getLoginUrl } from "@/const";
import { useLocation } from "wouter";
import { Menu, LogOut, ChevronRight, Home, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  adminNavSections,
  getAdminRouteTitle,
  isAdminRouteActive,
} from "@/config/adminNavItems";
import { useDocumentHead } from "@/hooks/useDocumentHead";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface AdminLayoutProps {
  children: React.ReactNode;
}

/** A small, centered, non-alarming placeholder shown while auth is resolving or a redirect is about to happen - never "Access Denied", which would otherwise flash for every legitimately logged-in admin on every fresh page load. */
function CenteredStatus({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="flex flex-col items-center gap-3 text-slate-600">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p>{text}</p>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  // Every admin page renders through this one layout, so setting
  // noindex,nofollow here covers the entire /admin/* section in one place
  // instead of touching each of the 20+ individual admin page components.
  useDocumentHead({ robots: "noindex,nofollow" });
  const { user, loading, authMeError, logout, isLoggingOut, refresh } = useAuth();
  const [location, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // The single rule for admin access - see adminAccess.ts. Also used by
  // AdminDashboard (to gate its own queries) so the two can never disagree.
  const accessState = resolveAdminAccessState({ loading, user, authMeError });

  // Redirecting is a side effect, not something to trigger during render -
  // doing it here (not inline in the render body below) avoids a
  // "Cannot update a component while rendering a different component"
  // warning/render-time navigation, and re-runs cleanly if accessState
  // flips back and forth (e.g. a query refetch). Uses the SAME
  // resolveUnauthorizedRedirectTarget helper as useAuth's own redirect
  // effect and main.tsx's global tRPC error handler - AdminLayout only
  // ever renders on /admin/* (there is no more separate /admin/login page
  // at all, see App.tsx's route table and
  // security/remove-local-admin-password-login), so this always resolves
  // to "admin_login" in practice, but sharing the helper keeps all three
  // places agreeing on the rule by construction instead of by convention.
  // getLoginUrl() is only called for the (here, unreachable) "oauth" case -
  // never unconditionally.
  useEffect(() => {
    if (accessState !== "unauthenticated") return;
    const target = resolveUnauthorizedRedirectTarget(location);
    if (target === "none") return;
    navigate(target === "admin_login" ? "/login" : getLoginUrl());
  }, [accessState, location, navigate]);

  async function handleLogout() {
    if (isLoggingOut) return;
    try {
      await logout();
      // Only reached on success or the already-logged-out (UNAUTHORIZED)
      // case - useAuth's logout() rethrows any other (unexpected) error,
      // which is caught below without navigating away. See
      // logoutOutcome.ts: a transient logout failure must never look like
      // "you got logged out."
      navigate("/login");
    } catch {
      toast.error("Logout failed. Please try again.");
    }
  }

  if (accessState === "loading") {
    return <CenteredStatus text="กำลังตรวจสอบสิทธิ์ผู้ดูแล..." />;
  }

  if (accessState === "unauthenticated") {
    // The redirect effect above handles navigation; this is only the brief
    // placeholder shown while that happens.
    return <CenteredStatus text="กำลังนำไปยังหน้าเข้าสู่ระบบ..." />;
  }

  if (accessState === "error") {
    // auth.me itself failed (infrastructure error - never a logout
    // failure, see adminAccess.ts's authMeError docstring). Never show the
    // raw error - it may carry database/infra details - and never treat
    // this as "not logged in" or "not an admin", both of which are
    // meaningful, different states this one must not be confused with.
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Card className="p-8 text-center max-w-md">
          <AlertTriangle className="w-10 h-10 mx-auto mb-4 text-amber-500" aria-hidden="true" />
          <h1 className="text-2xl font-bold mb-4 text-slate-900">
            Unable to verify your session
          </h1>
          <p className="text-slate-600 mb-6">
            Something went wrong while checking your admin access. Please try again.
          </p>
          <Button onClick={() => refresh()}>
            <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  if (accessState === "forbidden") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Card className="p-8 text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4 text-slate-900">
            Access Denied
          </h1>
          <p className="text-slate-600 mb-6">
            You do not have permission to access the admin panel.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button variant="outline" asChild>
              <a href="/">Return to Home</a>
            </Button>
            <Button onClick={handleLogout} disabled={isLoggingOut}>
              {isLoggingOut ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4 mr-2" />
              )}
              {isLoggingOut ? "Logging out..." : "Log out / switch account"}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const isActive = (href: string) => isAdminRouteActive(location, href);
  const currentPageTitle = getAdminRouteTitle(location);

  const navigation = (
    <>
      <div className="shrink-0 border-b border-slate-800 px-5 py-5 pr-14">
        <h1 className="text-lg font-bold">Admin Panel</h1>
        <p className="mt-1 text-xs text-slate-400">Manage your store</p>
      </div>
      <nav
        aria-label="Admin navigation"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-3"
      >
        {adminNavSections.map(section => (
          <div key={section.title}>
            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {section.title}
            </div>
            <div className="mt-1 space-y-1">
              {section.items.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => {
                      navigate(item.href);
                      setMobileMenuOpen(false);
                    }}
                    aria-current={isActive(item.href) ? "page" : undefined}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                      isActive(item.href)
                        ? "bg-blue-600 text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.badge && (
                      <span className="rounded-full bg-red-500 px-2 py-1 text-xs text-white">
                        {item.badge}
                      </span>
                    )}
                    {isActive(item.href) && (
                      <ChevronRight
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-slate-800 bg-slate-800 p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
            {user?.name?.charAt(0) || "A"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">
              {user?.name || "Admin"}
            </p>
            <p className="truncate text-xs text-slate-400">
              {user?.email || "admin@store.com"}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 w-full border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
          onClick={() => {
            setMobileMenuOpen(false);
            void handleLogout();
          }}
          disabled={isLoggingOut}
        >
          {isLoggingOut ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {isLoggingOut ? "Logging out..." : "Logout"}
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-slate-50">
      {/* Mobile Top Bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center border-b border-slate-200 bg-white px-2 shadow-sm sm:px-3 lg:hidden">
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="mr-2 min-h-11 shrink-0 gap-2 border-slate-300 px-3 font-semibold text-slate-800 shadow-sm"
              aria-label="Open Admin Menu"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
              <span>Admin Menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="flex h-dvh w-[min(20rem,88vw)] flex-col gap-0 overflow-hidden border-slate-800 bg-slate-900 p-0 text-white [&>button]:right-4 [&>button]:top-5 [&>button]:z-10 [&>button]:flex [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:items-center [&>button]:justify-center [&>button]:text-slate-300"
          >
            <SheetTitle className="sr-only">Admin navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Navigate between administration pages
            </SheetDescription>
            {navigation}
          </SheetContent>
        </Sheet>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">
          {currentPageTitle}
        </h1>
      </header>

      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col overflow-hidden bg-slate-900 text-white lg:flex">
        {navigation}
      </aside>

      {/* Main Content */}
      <main className="min-w-0 pt-14 lg:ml-64 lg:pt-0">
        {/* Top Bar (Desktop) */}
        <div className="sticky top-0 z-30 hidden border-b border-slate-200 bg-white px-6 py-4 lg:block">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">
                {currentPageTitle}
              </h2>
            </div>
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                className="text-slate-700 border-slate-300 hover:bg-slate-100"
                asChild
              >
                <a href="/">
                  <Home className="w-4 h-4 mr-2" />
                  Home
                </a>
              </Button>
              <div className="text-right">
                <p className="text-sm font-medium text-slate-900">
                  {user?.name || "Admin"}
                </p>
                <p className="text-xs text-slate-600">
                  {user?.role || "admin"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Page Content - Responsive Padding */}
        <div className="mx-auto min-w-0 max-w-[100rem] p-3 sm:p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
