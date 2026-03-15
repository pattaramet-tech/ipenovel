import React, { createContext, useContext, useState, useEffect } from "react";

type Language = "th" | "en";

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// Translation dictionary
const translations: Record<Language, Record<string, string>> = {
  th: {
    // Navbar
    "nav.browse": "เรียดู",
    "nav.myNovels": "นวนิยายของฉัน",
    "nav.orders": "คำสั่งซื้อ",
    "nav.admin": "ผู้ดูแล",
    "nav.cart": "ตะกร้า",
    "nav.logout": "ออกจากระบบ",
    "nav.login": "เข้าสู่ระบบ",

    // Home page
    "home.title": "ค้นพบนวนิยายที่น่าสนใจ",
    "home.subtitle": "อ่านนวนิยายแปลด้วยตัวเลือกการชำระเงินที่ยืดหยุ่นและการเข้าถึงทันที",
    "home.browse": "เรียดูนวนิยาย",
    "home.myNovels": "นวนิยายของฉัน",
    "home.featured": "นวนิยายที่เด่น",
    "home.viewAll": "ดูทั้งหมด",
    "home.newReleases": "เพิ่งเข้าใหม่",
    "home.freeEpisodes": "ตอนฟรี",

    // Novels page
    "novels.title": "นวนิยาย",
    "novels.search": "ค้นหา...",
    "novels.noResults": "ไม่พบนวนิยาย",

    // Novel detail
    "novel.author": "ผู้เขียน",
    "novel.categories": "หมวดหมู่",
    "novel.episodes": "ตอน",
    "novel.totalEpisodes": "จำนวนตอนทั้งหมด",
    "novel.freeEpisodes": "ตอนฟรี",
    "novel.paidEpisodes": "ตอนจ่ายเงิน",
    "novel.free": "ฟรี",
    "novel.purchased": "ซื้อแล้ว",
    "novel.inCart": "ในตะกร้า",
    "novel.addToCart": "เพิ่มลงตะกร้า",
    "novel.clearSelection": "ล้างการเลือก",
    "novel.notFound": "ไม่พบนวนิยาย",
    "novel.notFoundDesc": "นวนิยายที่คุณกำลังมองหาไม่มีอยู่หรือถูกลบแล้ว",
    "novel.backToNovels": "กลับไปยังนวนิยาย",

    // Cart
    "cart.title": "ตะกร้า",
    "cart.empty": "ตะกร้าของคุณว่างเปล่า",
    "cart.checkout": "ชำระเงิน",
    "cart.total": "รวม",

    // Orders
    "orders.title": "คำสั่งซื้อ",
    "orders.noOrders": "ไม่มีคำสั่งซื้อ",

    // My Novels
    "myNovels.title": "นวนิยายของฉัน",
    "myNovels.noPurchases": "คุณยังไม่ได้ซื้อนวนิยายใด ๆ",
    "myNovels.download": "ดาวน์โหลด",

    // Admin
    "admin.dashboard": "แดชบอร์ด",
    "admin.novels": "นวนิยาย",
    "admin.episodes": "ตอน",
    "admin.categories": "หมวดหมู่",
    "admin.orders": "คำสั่งซื้อ",
    "admin.payments": "การชำระเงิน",
    "admin.entitlements": "สิทธิ์",
    "admin.settings": "การตั้งค่า",
    "admin.bulkUpload": "อัปโหลดจำนวนมาก",

    // Common
    "common.loading": "กำลังโหลด...",
    "common.error": "เกิดข้อผิดพลาด",
    "common.success": "สำเร็จ",
    "common.cancel": "ยกเลิก",
    "common.save": "บันทึก",
    "common.delete": "ลบ",
    "common.edit": "แก้ไข",
    "common.create": "สร้าง",
    "common.close": "ปิด",
  },
  en: {
    // Navbar
    "nav.browse": "Browse",
    "nav.myNovels": "My Novels",
    "nav.orders": "Orders",
    "nav.admin": "Admin",
    "nav.cart": "Cart",
    "nav.logout": "Logout",
    "nav.login": "Login",

    // Home page
    "home.title": "Discover Amazing Novels",
    "home.subtitle": "Read translated novels with flexible payment options and instant access",
    "home.browse": "Browse Novels",
    "home.myNovels": "My Novels",
    "home.featured": "Featured Novels",
    "home.viewAll": "View All",
    "home.newReleases": "New Releases",
    "home.freeEpisodes": "Free Episodes",

    // Novels page
    "novels.title": "Novels",
    "novels.search": "Search...",
    "novels.noResults": "No novels found",

    // Novel detail
    "novel.author": "Author",
    "novel.categories": "Categories",
    "novel.episodes": "Episodes",
    "novel.totalEpisodes": "Total Episodes",
    "novel.freeEpisodes": "Free Episodes",
    "novel.paidEpisodes": "Paid Episodes",
    "novel.free": "Free",
    "novel.purchased": "Purchased",
    "novel.inCart": "In Cart",
    "novel.addToCart": "Add to Cart",
    "novel.clearSelection": "Clear Selection",
    "novel.notFound": "Novel Not Found",
    "novel.notFoundDesc": "The novel you're looking for doesn't exist or has been removed.",
    "novel.backToNovels": "Back to Novels",

    // Cart
    "cart.title": "Cart",
    "cart.empty": "Your cart is empty",
    "cart.checkout": "Checkout",
    "cart.total": "Total",

    // Orders
    "orders.title": "Orders",
    "orders.noOrders": "No orders",

    // My Novels
    "myNovels.title": "My Novels",
    "myNovels.noPurchases": "You haven't purchased any novels yet",
    "myNovels.download": "Download",

    // Admin
    "admin.dashboard": "Dashboard",
    "admin.novels": "Novels",
    "admin.episodes": "Episodes",
    "admin.categories": "Categories",
    "admin.orders": "Orders",
    "admin.payments": "Payments",
    "admin.entitlements": "Entitlements",
    "admin.settings": "Settings",
    "admin.bulkUpload": "Bulk Upload",

    // Common
    "common.loading": "Loading...",
    "common.error": "Error",
    "common.success": "Success",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.create": "Create",
    "common.close": "Close",
  },
};

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("th");
  const [mounted, setMounted] = useState(false);

  // Load language from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("language") as Language | null;
    if (saved && (saved === "th" || saved === "en")) {
      setLanguageState(saved);
    }
    setMounted(true);
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("language", lang);
  };

  const t = (key: string): string => {
    return translations[language][key] || translations["en"][key] || key;
  };

  if (!mounted) {
    return <>{children}</>;
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
