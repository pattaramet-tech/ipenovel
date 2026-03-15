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
    "home.title": "ยินดีต้อนรับสู่ Ipe นิยายแปล",
    "home.subtitle": "Charcoal Gray Silver Gold Maya",
    "home.browse": "เรียดูนวนิยาย",
    "home.myNovels": "นวนิยายของฉัน",
    "home.featured": "นวนิยายที่เด่น",
    "home.viewAll": "ดูทั้งหมด",
    "home.newReleases": "เพิ่งเข้าใหม่",
    "home.freeEpisodes": "ตอนฟรี",
    "home.noFeatured": "ยังไม่มีนวนิยายที่เด่น",
    "home.noNew": "ยังไม่มีเพิ่งเข้าใหม่",
    "home.noFree": "ยังไม่มีตอนฟรี",

    // Novels page
    "novels.title": "นวนิยาย",
    "novels.search": "ค้นหา...",
    "novels.noResults": "ไม่พบนวนิยาย",

    // Novel detail
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
    "common.notFound": "ไม่พบ",
    "common.back": "กลับ",
    "common.search": "ค้นหา",
    "common.filter": "กรอง",
    "common.sort": "เรียงลำดับ",
    "common.price": "ราคา",
    "common.free": "ฟรี",
    "common.paid": "จ่ายเงิน",
    "common.status": "สถานะ",
    "common.action": "การกระทำ",
    "common.confirm": "ยืนยัน",
    "common.yes": "ใช่",
    "common.no": "ไม่",
    "common.total": "รวม",
    "common.subtotal": "รวมย่อย",
    "common.tax": "ภาษี",
    "common.discount": "ส่วนลด",
    "common.apply": "ใช้",
    "common.remove": "ลบ",
    "common.add": "เพิ่ม",
    "common.update": "อัปเดต",
    "common.download": "ดาวน์โหลด",
    "common.upload": "อัปโหลด",
    "common.submit": "ส่ง",
    "common.reset": "รีเซ็ต",
    "common.previous": "ก่อนหน้า",
    "common.next": "ถัดไป",
    "common.page": "หน้า",
    "common.of": "ของ",
    "common.results": "ผลลัพธ์",
    "common.noData": "ไม่มีข้อมูล",
    "common.emptyState": "ไม่มีอะไรที่นี่",
    "common.tryAgain": "ลองอีกครั้ง",
    "common.errorOccurred": "เกิดข้อผิดพลาด",
    "common.pleaseWait": "กรุณารอสักครู่...",
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
    "home.title": "Welcome to Ipe Translated Novels",
    "home.subtitle": "Charcoal Gray Silver Gold Maya",
    "home.browse": "Browse Novels",
    "home.myNovels": "My Novels",
    "home.featured": "Featured Novels",
    "home.viewAll": "View All",
    "home.newReleases": "New Releases",
    "home.freeEpisodes": "Free Episodes",
    "home.noFeatured": "No featured novels available yet",
    "home.noNew": "No new releases available yet",
    "home.noFree": "No free episodes available yet",

    // Novels page
    "novels.title": "Novels",
    "novels.search": "Search...",
    "novels.noResults": "No novels found",

    // Novel detail
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
    "common.notFound": "Not Found",
    "common.back": "Back",
    "common.search": "Search",
    "common.filter": "Filter",
    "common.sort": "Sort",
    "common.price": "Price",
    "common.free": "Free",
    "common.paid": "Paid",
    "common.status": "Status",
    "common.action": "Action",
    "common.confirm": "Confirm",
    "common.yes": "Yes",
    "common.no": "No",
    "common.total": "Total",
    "common.subtotal": "Subtotal",
    "common.tax": "Tax",
    "common.discount": "Discount",
    "common.apply": "Apply",
    "common.remove": "Remove",
    "common.add": "Add",
    "common.update": "Update",
    "common.download": "Download",
    "common.upload": "Upload",
    "common.submit": "Submit",
    "common.reset": "Reset",
    "common.previous": "Previous",
    "common.next": "Next",
    "common.page": "Page",
    "common.of": "of",
    "common.results": "Results",
    "common.noData": "No data",
    "common.emptyState": "Nothing here",
    "common.tryAgain": "Try Again",
    "common.errorOccurred": "An error occurred",
    "common.pleaseWait": "Please wait...",
  },
};

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("th");

  // Load language from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("language") as Language | null;
    if (saved && (saved === "th" || saved === "en")) {
      setLanguageState(saved);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("language", lang);
  };

  const t = (key: string): string => {
    return translations[language][key] || translations["en"][key] || key;
  };

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
