import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import {
  Menu,
  X,
  LogOut,
  ChevronRight,
  Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getAdminNavItemsFlat } from "@/config/adminNavItems";

interface AdminLayoutProps {
  children: React.ReactNode;
}

// Get flattened nav items from shared config
const navItems = getAdminNavItemsFlat().map((item) => ({
  ...item,
  icon: <item.icon className="w-5 h-5" />,
}));

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Auth check
  if (!user || user.role !== "admin") {
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

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Mobile Menu Button */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <h1 className="font-bold text-slate-900">Admin</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 bottom-0 w-64 bg-slate-900 text-white transition-transform duration-300 z-40 ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* Logo */}
        <div className="p-6 border-b border-slate-800">
          <h1 className="text-xl font-bold">Admin Panel</h1>
          <p className="text-xs text-slate-400 mt-1">Manage your store</p>
        </div>

        {/* Navigation */}
        <nav className="mt-6 px-3 space-y-1 pb-32">
          {navItems.map((item) => (
            <button
              key={item.href}
              onClick={() => {
                navigate(item.href);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {item.icon}
              <span className="flex-1 text-left">{item.label}</span>
              {item.badge && (
                <span className="bg-red-500 text-white text-xs px-2 py-1 rounded-full">
                  {item.badge}
                </span>
              )}
              {isActive(item.href) && <ChevronRight className="w-4 h-4" />}
            </button>
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
        {/* Top Bar */}
        <div className="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-30">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">
                {navItems.find((item) => isActive(item.href))?.label || "Admin"}
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

        {/* Page Content */}
        <div className="p-6">{children}</div>
      </main>

      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-30 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </div>
  );
}
