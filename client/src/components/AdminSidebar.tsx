import { useLocation } from "wouter";
import {
  LayoutDashboard,
  BookOpen,
  FileText,
  Tag,
  Image,
  Ticket,
  ShoppingCart,
  CreditCard,
  Gift,
  Settings,
  ChevronRight,
  Trophy,
  Upload,
} from "lucide-react";

// Organized admin menu by sections
interface MenuSection {
  title: string;
  items: Array<{
    label: string;
    href: string;
    icon: React.ComponentType<{ className?: string }>;
  }>;
}

const adminMenuSections: MenuSection[] = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
    ],
  },
  {
    title: "Payments & Wallet",
    items: [
      { label: "Payments", href: "/admin/payments", icon: CreditCard },
      { label: "Wallet Top-ups", href: "/admin/wallet-topups", icon: Gift },
    ],
  },
  {
    title: "Votes & Campaigns",
    items: [
      { label: "Votes Manager", href: "/admin/sports-votes", icon: Trophy },
      { label: "Coupons", href: "/admin/coupons", icon: Ticket },
      { label: "Banners", href: "/admin/banners", icon: Image },
    ],
  },
  {
    title: "Content Management",
    items: [
      { label: "Novels", href: "/admin/novels", icon: BookOpen },
      { label: "Episodes", href: "/admin/episodes", icon: FileText },
      { label: "Categories", href: "/admin/categories", icon: Tag },
      { label: "Bulk Upload", href: "/admin/bulk-upload", icon: Upload },
    ],
  },
  {
    title: "Orders & Access",
    items: [
      { label: "Orders", href: "/admin/orders", icon: ShoppingCart },
      { label: "Entitlements", href: "/admin/entitlements", icon: Gift },
    ],
  },
  {
    title: "Settings",
    items: [
      { label: "Settings", href: "/admin/settings", icon: Settings },
    ],
  },
];

export default function AdminSidebar() {
  const [location, navigate] = useLocation();

  return (
    <div className="w-64 bg-slate-900 text-white h-screen flex flex-col fixed left-0 top-0">
      {/* Logo */}
      <div className="p-6 border-b border-slate-700">
        <h1 className="text-xl font-bold">Ipenovel Admin</h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-4">
        {adminMenuSections.map((section) => (
          <div key={section.title} className="mb-6">
            {/* Section Title */}
            <div className="px-4 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">
              {section.title}
            </div>

            {/* Section Items */}
            <div className="space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href;
                return (
                  <button
                    key={item.href}
                    onClick={() => navigate(item.href)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg transition ${
                      isActive
                        ? "bg-blue-600 text-white"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    <span className="flex-1 text-left text-sm">{item.label}</span>
                    {isActive && <ChevronRight className="w-4 h-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-slate-700 text-xs text-slate-400">
        <p>Admin Panel v1.0</p>
      </div>
    </div>
  );
}
