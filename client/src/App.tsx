import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Home from "@/pages/Home";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Navbar from "./components/Navbar";

// Route-level code splitting: only Home, NotFound, Navbar and the shared
// app shell (ErrorBoundary/ThemeProvider/TooltipProvider/Toaster) are
// needed to render the first paint of "/" - every other page is its own
// chunk, fetched only when a user actually navigates there.
const NovelsPage = lazy(() => import("@/pages/NovelsPage"));
const CartPage = lazy(() => import("@/pages/CartPage"));
const OrdersPage = lazy(() => import("./pages/OrdersPage"));
const OrderDetailPage = lazy(() => import("./pages/OrderDetailPage"));
const MyNovelsPage = lazy(() => import("@/pages/MyNovelsPage"));
const MyLibraryPage = lazy(() => import("@/pages/MyLibraryPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const AdminDashboard = lazy(() => import("@/pages/AdminDashboard"));
const AdminBannersPage = lazy(() => import("@/pages/AdminBannersPage"));
const AdminCouponsPage = lazy(() => import("@/pages/AdminCouponsPage"));
const AdminNovelsPage = lazy(() => import("@/pages/AdminNovelsPage"));
const AdminEpisodesPage = lazy(() => import("@/pages/AdminEpisodesPage"));
const AdminEpisodeImportPage = lazy(() => import("@/pages/AdminEpisodeImportPage"));
const AdminCategoriesPage = lazy(() => import("@/pages/AdminCategoriesPage"));
const AdminOrdersPage = lazy(() => import("@/pages/AdminOrdersPage"));
const AdminOrderDetailPage = lazy(() => import("@/pages/AdminOrderDetailPage"));
const AdminPaymentsPage = lazy(() => import("@/pages/AdminPaymentsPage"));
const AdminWalletTopupsPage = lazy(() => import("@/pages/AdminWalletTopupsPage"));
const AdminWalletTopupDetailPage = lazy(() => import("@/pages/AdminWalletTopupDetailPage"));
const AdminTopupLogsPage = lazy(() => import("@/pages/AdminTopupLogsPage"));
const AdminTopupLogDetailPage = lazy(() => import("@/pages/AdminTopupLogDetailPage"));
const AdminEntitlementsPage = lazy(() => import("@/pages/AdminEntitlementsPage"));
const AdminHybridHealthPage = lazy(() => import("@/pages/AdminHybridHealthPage"));
const AdminEntitlementLookupPage = lazy(() => import("@/pages/AdminEntitlementLookupPage"));
const AdminMediaMigrationPage = lazy(() => import("@/pages/AdminMediaMigrationPage"));
const AdminSettingsPage = lazy(() => import("@/pages/AdminSettingsPage"));
const AdminBulkUploadPage = lazy(() => import("@/pages/AdminBulkUploadPage"));
const AdminNovelManagePage = lazy(() => import("@/pages/AdminNovelManagePage"));
const AdminLoginPage = lazy(() => import("@/pages/AdminLoginPage"));
const AdminAnalyticsPage = lazy(() => import("@/pages/AdminAnalyticsPage"));
const NovelDetailPage = lazy(() => import("@/pages/NovelDetailPage"));
const PointsPage = lazy(() => import("@/pages/PointsPage"));
const PaymentPage = lazy(() => import("@/pages/PaymentPage"));
const WalletPage = lazy(() => import("@/pages/WalletPage"));
const SportsVotesPage = lazy(() => import("@/pages/SportsVotesPage"));
const AdminSportsVotesPage = lazy(() => import("@/pages/AdminSportsVotesPage"));
const ReaderPage = lazy(() => import("@/pages/ReaderPage"));

// Reserves vertical space (min-h) so swapping from/to this fallback never
// shifts surrounding layout (Navbar above stays put either way).
function RouteLoadingFallback() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-[60vh] w-full items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-slate-400" aria-hidden="true" />
      <span className="sr-only">กำลังโหลดหน้า...</span>
    </div>
  );
}

function Router() {
  return (
    <>
      <Navbar />
      <Suspense fallback={<RouteLoadingFallback />}>
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
          <Route path={"/points"} component={PointsPage} />
          <Route path={"/wallet"} component={WalletPage} />
          <Route path={"/payment/:orderId"} component={PaymentPage} />
          <Route path={"/sports-votes"} component={SportsVotesPage} />
          <Route path={"/admin/login"} component={AdminLoginPage} />
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
          <Route path="/404" component={NotFound} />
          {/* Final fallback route */}
          <Route component={NotFound} />
        </Switch>
      </Suspense>
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
