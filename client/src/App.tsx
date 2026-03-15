import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Home from "@/pages/Home";
import NovelsPage from "@/pages/NovelsPage";
import CartPage from "@/pages/CartPage";
import OrdersPage from "@/pages/OrdersPage";
import MyNovelsPage from "@/pages/MyNovelsPage";
import AdminDashboard from "@/pages/AdminDashboard";
import AdminBannersPage from "@/pages/AdminBannersPage";
import AdminCouponsPage from "@/pages/AdminCouponsPage";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Navbar from "./components/Navbar";

function Router() {
  return (
    <>
      <Navbar />
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/novels"} component={NovelsPage} />
        <Route path={"/cart"} component={CartPage} />
        <Route path={"/orders"} component={OrdersPage} />
        <Route path={"/my-novels"} component={MyNovelsPage} />
        <Route path={"/admin"} component={AdminDashboard} />
        <Route path={"/admin/banners"} component={AdminBannersPage} />
        <Route path={"/admin/coupons"} component={AdminCouponsPage} />
        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
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
