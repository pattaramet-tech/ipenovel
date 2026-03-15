import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  BarChart3,
  BookOpen,
  Layers,
  LogOut,
  Menu,
  Settings,
  ShoppingCart,
  Tag,
  User,
} from "lucide-react";
import { ReactNode } from "react";
import { Link, useLocation } from "wouter";

interface AdminLayoutProps {
  children: ReactNode;
  title?: string;
}

export default function AdminLayout({ children, title }: AdminLayoutProps) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  if (!user || user.role !== "admin") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
          <p className="text-muted-foreground mb-6">
            You do not have permission to access the admin panel.
          </p>
          <Link href="/">
            <Button>Return to Home</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const isActive = (path: string) => location === path;

  const menuItems = [
    {
      label: "Dashboard",
      icon: BarChart3,
      href: "/admin",
    },
    {
      label: "Content Management",
      icon: BookOpen,
      submenu: [
        { label: "Novels", href: "/admin/novels" },
        { label: "Episodes", href: "/admin/episodes" },
        { label: "Categories", href: "/admin/categories" },
      ],
    },
    {
      label: "Promotions",
      icon: Tag,
      submenu: [
        { label: "Banners", href: "/admin/banners" },
        { label: "Coupons", href: "/admin/coupons" },
      ],
    },
    {
      label: "Orders & Payments",
      icon: ShoppingCart,
      submenu: [
        { label: "Payments", href: "/admin/payments" },
        { label: "Orders", href: "/admin/orders" },
      ],
    },
    {
      label: "Tools",
      icon: Layers,
      submenu: [
        { label: "Entitlement Repair", href: "/admin/entitlements" },
      ],
    },
    {
      label: "Settings",
      icon: Settings,
      href: "/admin/settings",
    },
  ];

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full">
        {/* Sidebar */}
        <Sidebar className="border-r">
          <SidebarHeader className="border-b p-4">
            <Link href="/admin">
              <div className="flex items-center gap-2 cursor-pointer">
                <BookOpen className="w-6 h-6" />
                <span className="font-bold text-lg">Ipenovel Admin</span>
              </div>
            </Link>
          </SidebarHeader>

          <SidebarContent>
            <SidebarMenu>
              {menuItems.map((item, idx) => (
                <div key={idx}>
                  {item.submenu ? (
                    <div className="px-2 py-2">
                      <div className="flex items-center gap-2 px-2 py-2 text-sm font-semibold text-muted-foreground">
                        <item.icon className="w-4 h-4" />
                        {item.label}
                      </div>
                      <div className="pl-4 space-y-1">
                        {item.submenu.map((sub, subIdx) => (
                          <Link key={subIdx} href={sub.href}>
                            <SidebarMenuItem>
                              <SidebarMenuButton
                                isActive={isActive(sub.href)}
                                className="text-sm"
                              >
                                {sub.label}
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <Link href={item.href || "#"}>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={isActive(item.href || "")}
                          className="gap-2"
                        >
                          <item.icon className="w-4 h-4" />
                          {item.label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </Link>
                  )}
                </div>
              ))}
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top Bar */}
          <div className="border-b bg-background px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">{title || "Admin Panel"}</h1>
            </div>

            {/* User Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2">
                  <User className="w-4 h-4" />
                  {user.name || user.email || "Admin"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled>
                  <span className="text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => logout()}
                  className="text-red-600"
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-auto bg-muted/30 p-6">
            {children}
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}
