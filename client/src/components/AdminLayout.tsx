import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import {
  Menu,
  X,
  LogOut,
  ChevronRight,
  Home,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { adminNavSections } from "@/config/adminNavItems";
import { useDocumentHead } from "@/hooks/useDocumentHead";

interface AdminLayoutProps {
  children: React.ReactNode;
}

const allNavItems = adminNavSections.flatMap((section) => section.items);

export default function AdminLayout({ children }: AdminLayoutProps) {
  useDocumentHead({ robots: "noindex,nofollow" });
  const { user, loading } = useAuth();
  const [location, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-100">
        <div className="flex flex-col items-center gap-3 text-slate-600">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <p>กำลังตรวจสอบสิทธิ์ผู้ดูแล...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
        <Card className="w-full max-w-md border-slate-200 p-8 text-center shadow-sm">
          <h1 className="mb-4 text-2xl font-bold text-slate-900">Login Required</h1>
          <p className="mb-6 text-slate-600">
            กรุณาเข้าสู่ระบบเพื่อเข้าใช้งานส่วนผู้ดูแลระบบ
          </p>
          <Button asChild>
            <a href="/admin/login">เข้าสู่ระบบ</a>
          </Button>
        </Card>
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
        <Card className="w-full max-w-md border-slate-200 p-8 text-center shadow-sm">
          <h1 className="mb-4 text-2xl font-bold text-slate-900">Access Denied</h1>
          <p className="mb-6 text-slate-600">
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

  return (
    <div className="min-h-dvh bg-slate-100 text-slate-950">
      {mobileMenuOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-[1px] md:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close admin menu"
        />
      )}

      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-4 shadow-sm backdrop-blur md:hidden">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600">
            Control Panel
          </p>
          <h1 className="truncate text-sm font-semibold text-slate-900">{currentPageTitle}</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMobileMenuOpen(true)}
          className="ml-3 shrink-0 text-slate-700"
          aria-label="Open admin menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </header>

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[86vw] flex-col overflow-hidden border-r border-slate-800 bg-slate-950 text-white shadow-2xl transition-transform duration-200 ease-out md:w-64 md:max-w-none md:translate-x-0 md:shadow-none ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 shadow-lg shadow-blue-950/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold">IpeNovel Admin</h1>
              <p className="truncate text-xs text-slate-400">Control Panel</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileMenuOpen(false)}
            className="shrink-0 text-slate-400 hover:bg-slate-800 hover:text-white md:hidden"
            aria-label="Close admin menu"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {adminNavSections.map((section) => (
            <div key={section.title}>
              <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                {section.title}
              </div>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);

                  return (
                    <button
                      key={item.href}
                      type="button"
                      onClick={() => {
                        navigate(item.href);
                        setMobileMenuOpen(false);
                      }}
                      className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-blue-600 text-white shadow-sm shadow-blue-950/30"
                          : "text-slate-300 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate text-left">{item.label}</span>
                      {item.badge && (
                        <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs text-white">
                          {item.badge}
                        </span>
                      )}
                      {active && <ChevronRight className="h-4 w-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-slate-800 bg-slate-900/90 p-4">
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-slate-950/50 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
              {user.name?.charAt(0) || "A"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.name || "Admin"}</p>
              <p className="truncate text-xs text-slate-400">{user.email || "admin@store.com"}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white"
            asChild
          >
            <a href="/api/auth/logout">
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </a>
          </Button>
        </div>
      </aside>

      <main className="min-h-dvh min-w-0 pt-14 md:ml-64 md:pt-0">
        <div className="sticky top-0 z-20 hidden border-b border-slate-200 bg-white/90 shadow-sm backdrop-blur md:block">
          <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-6 lg:px-8">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600">
                Control Panel
              </p>
              <h2 className="truncate text-xl font-bold text-slate-900">{currentPageTitle}</h2>
            </div>
            <div className="ml-6 flex shrink-0 items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                asChild
              >
                <a href="/">
                  <Home className="mr-2 h-4 w-4" />
                  View Store
                </a>
              </Button>
              <div className="hidden border-l border-slate-200 pl-4 lg:block">
                <p className="max-w-48 truncate text-sm font-medium text-slate-900">
                  {user.name || "Admin"}
                </p>
                <p className="text-xs capitalize text-slate-500">{user.role || "admin"}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-5 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
