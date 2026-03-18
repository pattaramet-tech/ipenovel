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
    "nav.browse": "เรียกดู",
    "nav.myNovels": "นวนิยายของฉัน",
    "nav.orders": "คำสั่งซื้อ",
    "nav.admin": "ผู้ดูแล",
    "nav.cart": "ตะกร้า",
    "nav.logout": "ออกจากระบบ",
    "nav.login": "เข้าสู่ระบบ",
    "nav.points": "พอยท์",
    "nav.signedInAs": "ลงชื่อเข้าใช้เป็น",
    "nav.viewOrders": "ดูคำสั่งซื้อ",
    "nav.backToCart": "กลับไปยังตะกร้า",

    // Home page
    "home.title": "ยินดีต้อนรับสู่ Ipe นิยายแปล",
    "home.subtitle": "Charcoal Gray Silver Gold Maya",
    "home.browse": "เรียกดูนวนิยาย",
    "home.myNovels": "นวนิยายของฉัน",
    "home.featured": "นวนิยายที่นิยม",
    "home.viewAll": "ดูทั้งหมด",
    "home.newReleases": "เพิ่งเข้าใหม่",
    "home.freeEpisodes": "ตอนฟรี",
    "home.noFeatured": "ยังไม่มีนวนิยายที่นิยม",
    "home.noNew": "ยังไม่มีเพิ่งเข้าใหม่",
    "home.noFree": "ยังไม่มีตอนฟรี",
    "home.welcomeTag": "ยินดีต้อนรับสู่",
    "home.free": "ฟรี",
    "home.featuredDesc": "นวนิยายที่นิยมเลือกอย่างหมันดุจากผู้อ่าน",
    "home.newReleasesDesc": "นวนิยายใหม่ล่าสุด",
    "home.freeEpisodesDesc": "อ่านฟรีที่คุณสามารถอ่านได้ทันที",
    "home.latestEpisodes": "ตอนที่อัปโหลดล่าสุด",
    "home.latestEpisodesDesc": "ตอนที่อัปโหลดล่าสุดจากนวนิยายต่างๆ",
    "home.episode": "ตอน",
    "home.noEpisodes": "ยังไม่มีตอนที่อัปโหลด",
    "home.ctaTitle": "พร้อมเริ่มอ่านหรือ",
    "home.ctaDescription": "สำรวจคนหาที่สุดของนวนิยายแปลไทยที่สมบูรณ์และหาความสนใจใหม่ที่คุณชอบคหรณ์",
    "home.browseAll": "เริ่มอ่านทั้งหมด",

    // Novels page
    "novels.title": "นวนิยาย",
    "novels.search": "ค้นหา...",
    "novels.noResults": "ไม่พบนวนิยาย",

    // Novel detail
    "novel.categories": "หมวดหมู่",
    "novel.description": "รายละเอียด",
    "novel.episodes": "ตอน",
    "novel.totalEpisodes": "จำนวนตอนทั้งหมด",
    "novel.freeEpisodes": "ตอนฟรี",
    "novel.paidEpisodes": "ตอนเสียค่าใช้",
    "novel.free": "ฟรี",
    "novel.purchased": "ซื้อแล้ว",
    "novel.inCart": "ในตะกร้า",
    "novel.addToCart": "เพิ่มลงตะกร้า",
    "novel.clearSelection": "ล้างการเลือก",
    "novel.notFound": "ไม่พบนวนิยาย",
    "novel.notFoundDesc": "นวนิยายที่คุณกำลังมองหาไม่มีอยู่หรือถูกลบแล้ว",
    "novel.backToNovels": "กลับไปยังนวนิยาย",

    // Cart
    "cart.title": "ตะกร้าสินค้า",
    "cart.empty": "ตะกร้าของคุณว่างอยู่",
    "cart.checkout": "ดำเนินการชำระเงิน",
    "cart.total": "รวมทั้งสิ้น",
    "cart.continueShopping": "เลือกซื้อสินค้าต่อ",
    "cart.orderSummary": "สรุปคำสั่งซื้อ",
    "cart.subtotal": "ยอดรวมสินค้า",
    "cart.applyCoupon": "ใช้คูปอง",
    "cart.redeemPoints": "แลกคะแนน",
    "cart.availablePoints": "คะแนนคงเหลือ",

    // Checkout
    "checkout.proceedToCheckout": "ไปที่หน้าชำระเงิน",

    // Orders
    "orders.title": "คำสั่งซื้อของฉัน",
    "orders.noOrders": "ไม่มีคำสั่งซื้อ",
    "orders.orderItems": "รายการสั่งซื้อ",
    "orders.paymentInfo": "ข้อมูลการชำระเงิน",
    "orders.paymentSlip": "สลิปการชำระเงิน",
    "orders.submitted": "ส่งแล้ว",

    // My Novels
    "myNovels.title": "นิยายของฉัน",
    "myNovels.noPurchases": "คุณยังไม่ได้ซื้อนิยายใด ๆ",
    "myNovels.download": "ดาวน์โหลด",
    "myNovels.ongoing": "กำลังดำเนินเรื่อง",
    "myNovels.finished": "จบแล้ว",

    // Points
    "points.title": "พอยท์ของฉัน",
    "points.subtitle": "รับและใช้พอยท์กับการซื้อแต่ละครั้ง",
    "points.currentBalance": "ยอดพอยท์ปัจจุบัน",
    "points.balanceDescription": "พอยท์ที่มีให้ใช้เพื่อรับส่วนลด",
    "points.rules": "กฎของพอยท์",
    "points.earnRate": "อัตราการรับพอยท์",
    "points.redeemRate": "อัตราการแลกพอยท์",
    "points.point": "พอยท์",
    "points.history": "ประวัติพอยท์",
    "points.date": "วันที่",
    "points.type": "ประเภท",
    "points.amount": "จำนวน",
    "points.balance": "ยอดคงเหลือ",
    "points.reference": "อ้างอิง",
    "points.earned": "ได้รับ",
    "points.redeemed": "ใช้แล้ว",
    "points.noHistory": "ยังไม่มีประวัติพอยท์",
    "points.browseLinkText": "เรียกดูนวนิยาย",
    "points.checkoutLinkText": "ไปที่ชำระเงิน",

    // Payment
    "payment.title": "ชำระเงิน",
    "payment.subtitle": "สแกน QR และอัปโหลดสลิปการชำระเงิน",
    "payment.orderSummary": "สรุปคำสั่งซื้อ",
    "payment.orderNumber": "หมายเลขคำสั่งซื้อ",
    "payment.items": "จำนวนรายการ",
    "payment.totalAmount": "จำนวนเงินที่ต้องชำระ",
    "payment.amount": "จำนวนเงินที่ต้องชำระ:",
    "payment.status": "สถานะการชำระเงิน:",
    "payment.qrPayment": "ชำระเงินผ่าน QR Payment",
    "payment.selectFile": "เลือกไฟล์สลิปเพื่อแนบการชำระเงิน",
    "payment.fileRequirements": "จำเป็นต้องแนบไฟล์สลิปการชำระเงิน",
    "payment.uploadButton": "ส่งคำสั่งซื้อ",
    "payment.scanAndPay": "สแกน QR และชำระเงิน",
    "payment.instructions": "วิธีการชำระเงิน:",
    "payment.step1": "ใช้แอปพลิเคชันธนาคารของคุณสแกน QR code",
    "payment.step2": "ยืนยันจำนวนเงิน ฿ และดำเนินการชำระเงิน",
    "payment.step3": "บันทึกหรือถ่ายภาพสลิปการชำระเงิน",
    "payment.uploadSlip": "อัปโหลดสลิปการชำระเงิน",
    "payment.clickToUpload": "คลิกเพื่ออัปโหลดสลิป",
    "payment.fileFormats": "รูปแบบที่รองรับ: JPG, PNG, PDF (สูงสุด 5MB)",
    "payment.fileSelected": "ไฟล์ที่เลือก",
    "payment.submitSlip": "ส่งสลิป",
    "payment.slipSubmitted": "สลิปถูกส่งแล้ว",
    "payment.pendingReview": "รอการตรวจสอบจากผู้ดูแล",
    "payment.uploadNote": "หลังจากส่งสลิป ผู้ดูแลจะตรวจสอบและอนุมัติภายใน 1-2 ชั่วโมง",
    "payment.helpTitle": "ต้องการความช่วยเหลือ?",
    "payment.helpText": "หากคุณมีปัญหาในการชำระเงิน โปรดติดต่อเรา",
    "payment.slipUploadSuccess": "อัปโหลดสลิปสำเร็จ",
    "payment.slipUploadError": "ไม่สามารถอัปโหลดสลิป",
    "payment.invalidFileType": "ประเภทไฟล์ไม่ถูกต้อง",
    "payment.fileTooLarge": "ไฟล์มีขนาดใหญ่เกินไป",
    "payment.selectFileFirst": "กรุณาเลือกไฟล์ก่อน",
    "payment.uploadFailed": "ไม่สามารถอัปโหลดไฟล์",
    "payment.approved": "ชำระเงินได้รับการอนุมัติ",
    "payment.accessGranted": "ชำระเงินของคุณได้รับการอนุมัติแล้ว คุณสามารถเข้าถึงตอนที่ซื้อได้",
    "payment.rejected": "ชำระเงินถูกปฏิเสธ",
    "payment.rejectionReason": "เหตุผล",
    "payment.uploadNewSlip": "อัปโหลดสลิปใหม่",
    "payment.orderNotFound": "ไม่พบคำสั่งซื้อ",
    "payment.invalidOrder": "ลำดับที่คำสั่งซื้อไม่ถูกต้อง",

    // Admin
    "admin.dashboard": "แดชบอร์ด",
    "admin.novels": "นวนิยาย",
    "admin.episodes": "ตอน",
    "admin.categories": "หมวดหมู่",
    "admin.orders": "คำสั่งซื้อ",
    "admin.payments": "การชำระเงิน",
    "admin.entitlements": "สิทธิ์การเข้าถึง",
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
    "common.paid": "เสียค่าใช้",
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
    "common.emptyState": "ไม่มีข้อมูล",
    "common.tryAgain": "ลองอีกครั้ง",
    "common.errorOccurred": "เกิดข้อผิดพลาด",
    "common.pleaseWait": "กรุณารอสักครู่...",

    // Status labels
    "status.published": "ตีพิมพ์",
    "status.archived": "เก็บถาวร",
    "status.ongoing": "กำลังดำเนินการ",
    "status.finished": "เสร็จสิ้น",
    "status.pending": "รอดำเนินการ",
    "status.free": "ฟรี",
    "status.paid": "เสียค่าใช้",
    "status.episodes": "ตอน",
    "status.paidEpisodes": "ตอนที่ต้องชำระเงิน",
    "status.totalEpisodes": "ตอนทั้งหมด",
    "status.freeEpisodes": "ตอนที่อ่านฟรี",

    // Order workflow status (Badge 1)
    "order.status.pending": "รอดำเนินการ",
    "order.status.submitted": "รอดำเนินการ",
    "order.status.approved": "อนุมัติแล้ว",
    "order.status.rejected": "ถูกปฏิเสธ",

    // Payment status (Badge 2)
    "payment.status.unpaid": "ยังไม่ชำระเงิน",
    "payment.status.submitted": "ส่งแล้ว",
    "payment.status.approved": "ชำระเงินแล้ว",
    "payment.status.paid": "ชำระเงินแล้ว",
    "payment.status.rejected": "ถูกปฏิเสธ",

    // Unavailable novel
    "novel.unavailable": "ไม่สามารถดูนิยายเรื่องนี้ได้",
    "novel.unavailableDesc": "นิยายเรื่องนี้ถูกซ่อนหรือไม่พร้อมให้เข้าชมในขณะนี้",

    // Admin labels
    "admin.freeEpisode": "ตอนฟรี",
    "admin.paidEpisode": "ตอนเสียค่าใช้",
    "admin.pendingPayments": "การชำระเงินรอดำเนินการ",
    "admin.noPendingPayments": "ไม่มีการชำระเงินรอดำเนินการ",
    "admin.myNovels": "นิยายของฉัน",
  },
  en: {
    // Navbar
    "nav.browse": "Browse",
    "nav.myNovels": "My Novels",
    "nav.orders": "Orders",
    "nav.admin": "Admin",
    "nav.cart": "Cart",
    "nav.logout": "Logout",
    "nav.login": "Sign In",
    "nav.points": "Points",
    "nav.signedInAs": "Signed in as",
    "nav.viewOrders": "View Orders",
    "nav.backToCart": "Back to Cart",

    // Home page
    "home.title": "Welcome to Ipe นิยายแปล",
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
    "home.welcomeTag": "Welcome",
    "home.free": "Free",
    "home.featuredDesc": "Popular novels handpicked by our readers",
    "home.newReleasesDesc": "Latest releases",
    "home.freeEpisodesDesc": "Free episodes you can read instantly",
    "home.latestEpisodes": "Latest Uploaded Episodes",
    "home.latestEpisodesDesc": "Latest episodes uploaded from various novels",
    "home.episode": "Episode",
    "home.noEpisodes": "No episodes uploaded yet",
    "home.ctaTitle": "Ready to Start Reading?",
    "home.ctaDescription": "Browse our collection of translated novels and find your next favorite read.",
    "home.browseAll": "Browse All Novels",

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

    // Checkout
    "checkout.proceedToCheckout": "Go to Payment Page",

    // Orders
    "orders.title": "Orders",
    "orders.noOrders": "No orders",

    // My Novels
    "myNovels.title": "My Novels",
    "myNovels.noPurchases": "You haven't purchased any novels yet",
    "myNovels.download": "Download",

    // Points
    "points.title": "My Points",
    "points.subtitle": "Earn and redeem points with every purchase",
    "points.currentBalance": "Current Balance",
    "points.balanceDescription": "Available points to redeem for discounts",
    "points.rules": "Points Rules",
    "points.earnRate": "Earn Rate",
    "points.redeemRate": "Redemption Rate",
    "points.point": "Point",
    "points.history": "Points History",
    "points.date": "Date",
    "points.type": "Type",
    "points.amount": "Amount",
    "points.balance": "Balance",
    "points.reference": "Reference",
    "points.earned": "Earned",
    "points.redeemed": "Redeemed",
    "points.noHistory": "No points history yet",
    "points.browseLinkText": "Browse Novels",
    "points.checkoutLinkText": "Go to Checkout",

    // Payment
    "payment.title": "Payment",
    "payment.subtitle": "Scan QR and upload payment slip",
    "payment.orderSummary": "Order Summary",
    "payment.orderNumber": "Order Number",
    "payment.items": "Items",
    "payment.totalAmount": "Total Amount",
    "payment.scanAndPay": "Scan QR and Pay",
    "payment.instructions": "Payment Instructions:",
    "payment.step1": "Use your bank app to scan the QR code",
    "payment.step2": "Confirm the amount and complete the payment",
    "payment.step3": "Save or take a photo of the payment slip",
    "payment.uploadSlip": "Upload Payment Slip",
    "payment.clickToUpload": "Click to upload slip",
    "payment.fileFormats": "Supported formats: JPG, PNG, PDF (max 5MB)",
    "payment.fileSelected": "File selected",
    "payment.submitSlip": "Submit Slip",
    "payment.slipSubmitted": "Slip Submitted",
    "payment.pendingReview": "Awaiting admin verification",
    "payment.uploadNote": "After submission, admin will verify and approve within 1-2 hours",
    "payment.helpTitle": "Need Help?",
    "payment.helpText": "If you have any issues with payment, please contact us",
    "payment.slipUploadSuccess": "Payment slip uploaded successfully",
    "payment.slipUploadError": "Failed to upload payment slip",
    "payment.invalidFileType": "Invalid file type",
    "payment.fileTooLarge": "File is too large",
    "payment.selectFileFirst": "Please select a file first",
    "payment.uploadFailed": "Failed to upload file",
    "payment.approved": "Payment Approved",
    "payment.accessGranted": "Your payment has been approved. You now have access to your purchased episodes.",
    "payment.rejected": "Payment Rejected",
    "payment.rejectionReason": "Reason",
    "payment.uploadNewSlip": "Upload New Payment Slip",
    "payment.orderNotFound": "Order Not Found",
    "payment.invalidOrder": "Invalid order ID",

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

    // Status labels
    "status.published": "Published",
    "status.archived": "Archived",
    "status.ongoing": "Ongoing",
    "status.finished": "Finished",
    "status.pending": "Pending",
    "status.free": "Free",
    "status.paid": "Paid",

    // Order workflow status (Badge 1)
    "order.status.pending": "Pending",
    "order.status.submitted": "Pending",
    "order.status.approved": "Approved",
    "order.status.rejected": "Rejected",

    // Payment status (Badge 2)
    "payment.status.unpaid": "Unpaid",
    "payment.status.submitted": "Submitted",
    "payment.status.approved": "Paid",
    "payment.status.paid": "Paid",
    "payment.status.rejected": "Rejected",

    // Unavailable novel
    "novel.unavailable": "Novel Not Available",
    "novel.unavailableDesc": "This novel is hidden or not available at this time.",

    // Admin labels
    "admin.freeEpisode": "Free Episode",
    "admin.paidEpisode": "Paid Episode",
    "admin.pendingPayments": "Pending Payments",
    "admin.noPendingPayments": "No Pending Payments",
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
