import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { BookOpen, ShoppingCart, LogOut, Menu, X, Settings } from "lucide-react";
import { useState } from "react";
import { getLoginUrl } from "@/const";
import LanguageSwitcher from "@/components/LanguageSwitcher";

export default function Navbar() {
  const { user, logout, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  const navLinks = [
    { label: "Browse", href: "/novels" },
    { label: "My Novels", href: "/my-novels", auth: true },
    { label: "Orders", href: "/orders", auth: true },
    { label: "Points", href: "/points", auth: true },
  ];

  const adminLinks = [
    { label: "Admin", href: "/admin", auth: true, adminOnly: true },
  ];

  return (
    <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => navigate("/")}
          >
            <BookOpen className="w-6 h-6 text-blue-600" />
            <span className="font-bold text-lg text-slate-900">Ipenovel</span>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => {
              if (link.auth && !isAuthenticated) return null;
              return (
                <button
                  key={link.href}
                  onClick={() => navigate(link.href)}
                  className="text-slate-600 hover:text-slate-900 font-medium transition"
                >
                  {link.label}
                </button>
              );
            })}
            
            {/* Admin Link */}
            {user?.role === "admin" && (
              <button
                onClick={() => navigate("/admin")}
                className="text-slate-600 hover:text-slate-900 font-medium transition flex items-center gap-2 px-3 py-1 rounded-lg hover:bg-slate-100"
              >
                <Settings className="w-4 h-4" />
                Admin
              </button>
            )}
          </div>

          {/* Right Section */}
          <div className="hidden md:flex items-center gap-4">
            <LanguageSwitcher />
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/cart")}
              className="relative"
            >
              <ShoppingCart className="w-5 h-5" />
              <span className="text-xs">Cart</span>
            </Button>

            {isAuthenticated ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">{user?.name}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLogout}
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  Logout
                </Button>
              </div>
            ) : (
              <Button size="sm" asChild>
                <a href={getLoginUrl()}>Login</a>
              </Button>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? (
              <X className="w-6 h-6" />
            ) : (
              <Menu className="w-6 h-6" />
            )}
          </button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden pb-4 border-t border-slate-200">
              <div className="flex flex-col gap-3 pt-4">
              <div className="px-2 py-2">
                <LanguageSwitcher />
              </div>
              
              {navLinks.map((link) => {
                if (link.auth && !isAuthenticated) return null;
                return (
                  <button
                    key={link.href}
                    onClick={() => {
                      navigate(link.href);
                      setMobileMenuOpen(false);
                    }}
                    className="text-left text-slate-600 hover:text-slate-900 font-medium py-2"
                  >
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
                  className="text-left text-slate-600 hover:text-slate-900 font-medium py-2 flex items-center gap-2"
                >
                  <Settings className="w-4 h-4" />
                  Admin
                </button>
              )}

              <div className="flex flex-col gap-2 pt-2 border-t border-slate-200">
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    navigate("/cart");
                    setMobileMenuOpen(false);
                  }}
                >
                  <ShoppingCart className="w-4 h-4 mr-2" />
                  Cart
                </Button>

                {isAuthenticated ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={handleLogout}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Logout
                  </Button>
                ) : (
                  <Button asChild className="justify-start">
                    <a href={getLoginUrl()}>Login</a>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
