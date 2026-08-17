import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Home from "@/pages/Home";
import NovelsPage from "@/pages/NovelsPage";
import CartPage from "@/pages/CartPage";
import OrdersPage from "./pages/OrdersPage";
import OrderDetailPage from "./pages/OrderDetailPage";
import MyNovelsPage from "@/pages/MyNovelsPage";
import MyLibraryPage from "@/pages/MyLibraryPage";
import ProfilePage from "@/pages/ProfilePage";
import LoginPage from "@/pages/LoginPage";
import UpgradeLoginPage from "@/pages/UpgradeLoginPage";
import AccountRecoveryPage from "@/pages/AccountRecoveryPage";
import AdminAccountRecoveryPage from "@/pages/AdminAccountRecoveryPage";
import AdminAccountRecoveryDetailPage from "@/pages/AdminAccountRecoveryDetailPage";
import AdminDashboard from "@/pages/AdminDashboard";
import AdminBannersPage from "@/pages/AdminBannersPage";
import AdminCouponsPage from "@/pages/AdminCouponsPage";
import AdminNovelsPage from "@/pages/AdminNovelsPage";
import AdminEpisodesPage from "@/pages/AdminEpisodesPage";
import AdminEpisodeImportPage from "@/pages/AdminEpisodeImportPage";
import AdminCategoriesPage from "@/pages/AdminCategoriesPage";
import AdminOrdersPage from "@/pages/AdminOrdersPage";
import AdminOrderDetailPage from "@/pages/AdminOrderDetailPage";
import AdminPaymentsPage from "@/pages/AdminPaymentsPage";
import AdminWalletTopupsPage from "@/pages/AdminWalletTopupsPage";
import AdminWalletTopupDetailPage from "@/pages/AdminWalletTopupDetailPage";
import AdminTopupLogsPage from "@/pages/AdminTopupLogsPage";
import AdminTopupLogDetailPage from "@/pages/AdminTopupLogDetailPage";
import AdminEntitlementsPage from "@/pages/AdminEntitlementsPage";
import AdminHybridHealthPage from "@/pages/AdminHybridHealthPage";
import AdminEntitlementLookupPage from "@/pages/AdminEntitlementLookupPage";
import AdminMediaMigrationPage from "@/pages/AdminMediaMigrationPage";
import AdminSettingsPage from "@/pages/AdminSettingsPage";
import AdminBulkUploadPage from "@/pages/AdminBulkUploadPage";
import AdminNovelManagePage from "@/pages/AdminNovelManagePage";
import AdminAnalyticsPage from "@/pages/AdminAnalyticsPage";
import NovelDetailPage from "@/pages/NovelDetailPage";
import PointsPage from "@/pages/PointsPage";
import PaymentPage from "@/pages/PaymentPage";
import WalletPage from "@/pages/WalletPage";
import SportsVotesPage from "@/pages/SportsVotesPage";
import AdminSportsVotesPage from "@/pages/AdminSportsVotesPage";
import ReaderPage from "@/pages/ReaderPage";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Navbar from "./components/Navbar";
import MigrationGate from "./components/MigrationGate";
import MaintenanceAnnouncementBanner from "./components/MaintenanceAnnouncementBanner";

function Router() {
  return (
    <>
      {/* Grouped under one sticky container (rather than each sticking
          independently) so the banner and Navbar stack cleanly at the top
          of the viewport instead of both competing for the same top:0
          position - see maintenanceBannerVisibility.ts. On Admin routes
          both return null, so this wrapper is empty there (harmless). On
          Reader routes the banner still renders (readers need the
          maintenance notice too) while Navbar stays hidden (Reader owns
          its own top chrome) - ReaderPage's own CSS reserves exactly the
          banner's rendered height via --maintenance-banner-height, so the
          two never overlap; see MaintenanceAnnouncementBanner.tsx and
          ReaderPage.module.css. */}
      <div className="sticky top-0 z-50">
        <MaintenanceAnnouncementBanner />
        <Navbar />
      </div>
      <MigrationGate>
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/novels"} component={NovelsPage} />
        <Route path={"/novels/:identifier"} component={NovelDetailPage} />
        <Route path={"/read/:episodeId"} component={ReaderPage} />
        <Route path={"/cart"} component={CartPage} />
        <Route path={"/orders"} component={OrdersPage} />
        <Route path={"/orders/:id"} component={OrderDetailPage} />
        <Route path={"/my-novels"} component={MyNovelsPage} />
        <Route path={"/my-library"} component={MyLibraryPage} />
        <Route path={"/profile"} component={ProfilePage} />
        <Route path={"/login"} component={LoginPage} />
        <Route path={"/account/upgrade-login"} component={UpgradeLoginPage} />
        <Route path={"/account/recovery"} component={AccountRecoveryPage} />
        <Route path={"/points"} component={PointsPage} />
        <Route path={"/wallet"} component={WalletPage} />
        <Route path={"/payment/:orderId"} component={PaymentPage} />
        <Route path={"/sports-votes"} component={SportsVotesPage} />
        <Route path={"/admin"} component={AdminDashboard} />
        <Route path={"/admin/novels/:novelId"} component={AdminNovelManagePage} />
        <Route path={"/admin/novels"} component={AdminNovelsPage} />
        <Route path={"/admin/episodes/:novelId"} component={AdminEpisodesPage} />
        <Route path={"/admin/episodes"} component={AdminEpisodesPage} />
        <Route path={"/admin/import-episodes"} component={AdminEpisodeImportPage} />
        <Route path={"/admin/categories"} component={AdminCategoriesPage} />
        <Route path={"/admin/banners"} component={AdminBannersPage} />
        <Route path={"/admin/coupons"} component={AdminCouponsPage} />
        <Route path="/admin/orders" component={AdminOrdersPage} />
        <Route path="/admin/orders/:orderId" component={AdminOrderDetailPage} />
        <Route path={"/admin/payments"} component={AdminPaymentsPage} />
        <Route path={"/admin/wallet-topups"} component={AdminWalletTopupsPage} />
        <Route path={"/admin/wallet-topups/:topupId"} component={AdminWalletTopupDetailPage} />
        <Route path={"/admin/topup-logs"} component={AdminTopupLogsPage} />
        <Route path={"/admin/topup-logs/:logId"} component={AdminTopupLogDetailPage} />
        <Route path={"/admin/entitlements"} component={AdminEntitlementsPage} />
        <Route path={"/admin/hybrid-health"} component={AdminHybridHealthPage} />
        <Route path={"/admin/entitlement-lookup"} component={AdminEntitlementLookupPage} />
        <Route path={"/admin/media-migration"} component={AdminMediaMigrationPage} />
        <Route path="/admin/settings" component={AdminSettingsPage} />
        <Route path="/admin/bulk-upload" component={AdminBulkUploadPage} />
        <Route path="/admin/analytics" component={AdminAnalyticsPage} />
        <Route path="/admin/sports-votes" component={AdminSportsVotesPage} />
        <Route path="/admin/account-recovery/:requestId" component={AdminAccountRecoveryDetailPage} />
        <Route path="/admin/account-recovery" component={AdminAccountRecoveryPage} />
        <Route path="/404" component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
      </MigrationGate>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
