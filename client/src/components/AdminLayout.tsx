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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { adminNavSections } from "@/config/adminNavItems";
import { useDocumentHead } from "@/hooks/useDocumentHead";

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

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile Top Bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <h1 className="font-bold text-slate-900 truncate flex-1">{currentPageTitle}</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="ml-2"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 bottom-0 w-64 bg-slate-900 text-white transition-transform duration-300 z-40 overflow-y-auto ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* Logo */}
        <div className="p-6 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <h1 className="text-xl font-bold">Admin Panel</h1>
          <p className="text-xs text-slate-400 mt-1">Manage your store</p>
        </div>

        {/* Close Button (Mobile) */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobileMenuOpen(false)}
          className="md:hidden absolute top-6 right-6 text-slate-400 hover:text-white"
        >
          <X className="w-5 h-5" />
        </Button>

        {/* Navigation with Sections */}
        <nav className="p-4 space-y-6 pb-32 mt-6">
          {adminNavSections.map((section) => (
            <div key={section.title}>
              {/* Section Title */}
              <div className="px-4 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">
                {section.title}
              </div>
              {/* Section Items */}
              <div className="space-y-1 mt-2">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.href}
                      onClick={() => {
                        navigate(item.href);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors min-h-11 md:min-h-auto ${
                        isActive(item.href)
                          ? "bg-blue-600 text-white"
                          : "text-slate-300 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 text-left">{item.label}</span>
                      {item.badge && (
                        <span className="bg-red-500 text-white text-xs px-2 py-1 rounded-full">
                          {item.badge}
                        </span>
                      )}
                      {isActive(item.href) && <ChevronRight className="w-4 h-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* User Info */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-slate-800 p-4 bg-slate-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
              {user?.name?.charAt(0) || "A"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name || "Admin"}</p>
              <p className="text-xs text-slate-400 truncate">{user?.email || "admin@store.com"}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full text-slate-300 border-slate-600 hover:bg-slate-700 hover:text-white"
            asChild
          >
            <a href="/api/auth/logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </a>
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="md:ml-64 pt-16 md:pt-0">
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
        <div className="p-3 sm:p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
