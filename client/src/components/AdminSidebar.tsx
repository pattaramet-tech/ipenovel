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
} from "lucide-react";

const adminMenuItems = [
  { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Payments", href: "/admin/payments", icon: CreditCard },
  { label: "Novels", href: "/admin/novels", icon: BookOpen },
  { label: "Episodes", href: "/admin/episodes", icon: FileText },
  { label: "Categories", href: "/admin/categories", icon: Tag },
  { label: "Banners", href: "/admin/banners", icon: Image },
  { label: "Coupons", href: "/admin/coupons", icon: Ticket },
  { label: "Orders", href: "/admin/orders", icon: ShoppingCart },
  { label: "Entitlements", href: "/admin/entitlements", icon: Gift },
  { label: "Settings", href: "/admin/settings", icon: Settings },
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
        {adminMenuItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href;
          return (
            <button
              key={item.href}
              onClick={() => navigate(item.href)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="flex-1 text-left">{item.label}</span>
              {isActive && <ChevronRight className="w-4 h-4" />}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-slate-700 text-xs text-slate-400">
        <p>Admin Panel v1.0</p>
      </div>
    </div>
  );
}
