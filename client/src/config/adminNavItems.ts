/**
 * Admin Navigation Configuration
 * Single source of truth for admin sidebar and mobile menu
 * Used by: AdminSidebar.tsx (sections), AdminLayout.tsx (flattened)
 */

import {
  LayoutDashboard,
  BookOpen,
  Layers,
  Tag,
  Image,
  Ticket,
  ShoppingCart,
  CreditCard,
  Gift,
  Settings,
  Upload,
  Wallet,
  History,
  Trophy,
  BarChart3,
  FileSpreadsheet,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * Admin menu organized by sections (for sidebar)
 * Mobile layout flattens this structure
 */
export const adminNavSections: NavSection[] = [
  {
    title: "Main",
    items: [
      {
        label: "Dashboard",
        href: "/admin",
        icon: LayoutDashboard,
      },
      {
        label: "Analytics",
        href: "/admin/analytics",
        icon: BarChart3,
      },
    ],
  },
  {
    title: "Sales",
    items: [
      {
        label: "Orders",
        href: "/admin/orders",
        icon: ShoppingCart,
      },
      {
        label: "Payments",
        href: "/admin/payments",
        icon: CreditCard,
      },
      {
        label: "Wallet Top-ups",
        href: "/admin/wallet-topups",
        icon: Wallet,
      },
      {
        label: "Top-up Logs",
        href: "/admin/topup-logs",
        icon: History,
      },
    ],
  },
  {
    title: "Content",
    items: [
      {
        label: "Novels",
        href: "/admin/novels",
        icon: BookOpen,
      },
      {
        label: "Episodes",
        href: "/admin/episodes",
        icon: Layers,
      },
      {
        label: "Import Episodes",
        href: "/admin/import-episodes",
        icon: FileSpreadsheet,
      },
      {
        label: "Categories",
        href: "/admin/categories",
        icon: Tag,
      },
      {
        label: "Bulk Upload",
        href: "/admin/bulk-upload",
        icon: Upload,
      },
    ],
  },
  {
    title: "Marketing",
    items: [
      {
        label: "Coupons",
        href: "/admin/coupons",
        icon: Ticket,
      },
      {
        label: "Banners",
        href: "/admin/banners",
        icon: Image,
      },
      {
        label: "Sports Votes",
        href: "/admin/sports-votes",
        icon: Trophy,
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        label: "Entitlements",
        href: "/admin/entitlements",
        icon: Gift,
      },
      {
        label: "Settings",
        href: "/admin/settings",
        icon: Settings,
      },
    ],
  },
];

/**
 * Flatten sections into single array for mobile menu
 * Used by AdminLayout for responsive mobile navigation
 */
export function getAdminNavItemsFlat(): NavItem[] {
  return adminNavSections.flatMap((section) => section.items);
}
