import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import {
  Menu,
  LogOut,
  ChevronRight,
  Home,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { adminNavSections } from "@/config/adminNavItems";
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

// Get all nav items (flattened for quick lookup)
const allNavItems = adminNavSections.flatMap((section) => section.items);

export default function AdminLayout({ children }: AdminLayoutProps) {
  // Every admin page renders through this one layout, so setting
  // noindex,nofollow here covers the entire /admin/* section in one place
  // instead of touching each of the 20+ individual admin page components.
  useDocumentHead({ robots: "noindex,nofollow" });
  const { user, loading } = useAuth();
  const [location, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // While auth.me is still resolving (e.g. a hard refresh on /admin/*, before
  // the session cookie has round-tripped), `user` is still null - render a
  // loading state instead of "Access Denied", which would otherwise flash
  // for every legitimately logged-in admin on every fresh page load.
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-600">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p>กำลังตรวจสอบสิทธิ์ผู้ดูแล...</p>
        </div>
      </div>
    );
  }

  // Not logged in at all - offer a way to log in, distinct from "logged in
  // but not an admin" below.
  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Card className="p-8 text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4 text-slate-900">Login Required</h1>
          <p className="text-slate-600 mb-6">
            กรุณาเข้าสู่ระบบเพื่อเข้าใช้งานส่วนผู้ดูแลระบบ
          </p>
          <Button asChild>
            <a href="/admin/login">เข้าสู่ระบบ</a>
          </Button>
        </Card>
      </div>
    );
  }

  // Logged in, but not an admin - this is the real "Access Denied" case.
  if (user.role !== "admin") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Card className="p-8 text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4 text-slate-900">Access Denied</h1>
          <p className="text-slate-600 mb-6">
            You do not have permission to access the admin panel.
          </p>
          <Button asChild>
            <a href="/">Return to Home</a>
          </Button>
        </Card>
      </div>
    );
  }

  const isActive = (href: string) =>
    href === "/admin"
      ? location === "/admin"
      : location === href || location.startsWith(href + "/");

  const currentPageTitle = allNavItems.find((item) => isActive(item.href))?.label || "Admin";

  const navigation = (
    <>
      <div className="shrink-0 border-b border-slate-800 px-5 py-5">
        <h1 className="text-lg font-bold">Admin Panel</h1>
        <p className="mt-1 text-xs text-slate-400">Manage your store</p>
      </div>
      <nav aria-label="Admin navigation" className="flex-1 space-y-5 overflow-y-auto p-3">
        {adminNavSections.map((section) => (
          <div key={section.title}>
            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {section.title}
            </div>
            <div className="mt-1 space-y-1">
              {section.items.map((item) => {
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
                    {isActive(item.href) && <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
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
            <p className="truncate text-sm font-medium text-white">{user?.name || "Admin"}</p>
            <p className="truncate text-xs text-slate-400">{user?.email || "admin@store.com"}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 w-full border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white"
          asChild
        >
          <a href="/api/auth/logout">
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
            Logout
          </a>
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-slate-50">
      {/* Mobile Top Bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center border-b border-slate-200 bg-white px-3 md:hidden">
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="mr-2 min-h-11 min-w-11" aria-label="Open admin navigation">
              <Menu className="h-5 w-5" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[min(20rem,88vw)] gap-0 border-slate-800 bg-slate-900 p-0 text-white [&>button]:right-4 [&>button]:top-5 [&>button]:text-slate-300"
          >
            <SheetTitle className="sr-only">Admin navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Navigate between administration pages
            </SheetDescription>
            {navigation}
          </SheetContent>
        </Sheet>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">{currentPageTitle}</h1>
      </header>

      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-slate-900 text-white md:flex">
        {navigation}
      </aside>

      {/* Main Content */}
      <main className="min-w-0 pt-14 md:ml-64 md:pt-0">
        {/* Top Bar (Desktop) */}
        <div className="hidden md:block bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-30">
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
                <p className="text-sm font-medium text-slate-900">{user?.name || "Admin"}</p>
                <p className="text-xs text-slate-600">{user?.role || "admin"}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Page Content - Responsive Padding */}
        <div className="mx-auto min-w-0 max-w-[100rem] p-3 sm:p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
