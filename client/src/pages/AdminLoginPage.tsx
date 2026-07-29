import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { AlertCircle, LogIn, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useDocumentHead } from "@/hooks/useDocumentHead";
import { useAuth } from "@/_core/hooks/useAuth";

/**
 * Auth Phase 2A: this page no longer writes an "admin-session" localStorage
 * flag. The HttpOnly session cookie + `auth.me` (server-verified against the
 * database on every request - see server/_core/sdk.ts's authenticateRequest)
 * are the only source of truth for admin access, for this page and every
 * other /admin/* page.
 */
export default function AdminLoginPage() {
  useDocumentHead({ robots: "noindex,nofollow" });
  const [, navigate] = useLocation();
  const { user, loading: authLoading, logout, isLoggingOut } = useAuth();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // Already signed in as an admin - leave this page. A useEffect (not a
  // call during render) so this is a side effect the browser/React can
  // schedule normally, not something that runs while React is still
  // rendering the component tree.
  useEffect(() => {
    if (!authLoading && user?.role === "admin") {
      navigate("/admin");
    }
  }, [authLoading, user, navigate]);

  const adminLoginMutation = trpc.admin.login.useMutation({
    onSuccess: async () => {
      // Never trust this mutation's own `adminId` for client-side
      // authorization - it only proves the password matched, not that the
      // session cookie the server just set will actually resolve to an
      // admin. `auth.me` (fetched fresh here, not read from any stale
      // cache) is the only thing allowed to decide that.
      let freshUser: { role?: string | null } | null = null;
      try {
        freshUser = await utils.auth.me.fetch();
      } catch {
        freshUser = null;
      }

      if (freshUser?.role === "admin") {
        setIsLoading(false);
        toast.success("Admin login successful");
        navigate("/admin");
        return;
      }

      // The cookie may or may not have been set, but auth.me does not
      // confirm admin access - never navigate into /admin on this path, and
      // never leave the browser holding a session that looks half
      // logged-in. Best-effort clear it.
      setIsLoading(false);
      setError("Unable to verify admin access. Please try again.");
      try {
        await logout();
      } catch {
        // Best-effort only - a safe error is already shown either way.
      }
    },
    onError: () => {
      setIsLoading(false);
      setError("Invalid email or password");
      toast.error("Admin login failed");
    },
  });

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please enter email and password");
      return;
    }

    setIsLoading(true);
    adminLoginMutation.mutate({
      email: email.trim(),
      password,
    });
  };

  const handleLogoutAndSwitchAccount = async () => {
    if (isLoggingOut) return;
    try {
      await logout();
    } catch {
      toast.error("Logout failed. Please try again.");
    }
  };

  // auth.me is still resolving - don't show the form or the "wrong account"
  // screen yet, and don't decide anything about redirecting.
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center px-4 py-8">
        <div className="flex flex-col items-center gap-3 text-slate-600">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p>Checking your session...</p>
        </div>
      </div>
    );
  }

  // Signed in, but confirmed NOT an admin - never redirect into /admin.
  if (user && user.role !== "admin") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center px-4 py-8">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
            <CardTitle className="text-2xl font-bold">Admin Login</CardTitle>
          </CardHeader>
          <CardContent className="pt-8 space-y-6 text-center">
            <p className="text-slate-700">
              This account (<span className="font-medium">{user.email}</span>) does not have admin access.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Button variant="outline" asChild>
                <a href="/">Return to Home</a>
              </Button>
              <Button onClick={handleLogoutAndSwitchAccount} disabled={isLoggingOut}>
                {isLoggingOut ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <LogIn className="w-4 h-4 mr-2" />
                )}
                {isLoggingOut ? "Logging out..." : "Log out and use another account"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Signed in as an admin: the redirect effect above handles navigation.
  // Render a neutral transitional state instead of the form to avoid a
  // flash of the login screen for someone who is already authenticated.
  if (user && user.role === "admin") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center px-4 py-8">
        <div className="flex flex-col items-center gap-3 text-slate-600">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p>Redirecting to admin panel...</p>
        </div>
      </div>
    );
  }

  // Unauthenticated - show the normal admin login form.
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
          <CardTitle className="text-2xl font-bold">Admin Login</CardTitle>
        </CardHeader>
        <CardContent className="pt-8">
          <form onSubmit={handleLogin} className="space-y-6">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Email Address
              </label>
              <Input
                id="email"
                type="email"
                placeholder="admin@ipenovel.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                className="w-full"
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 h-auto"
            >
              <LogIn className="w-4 h-4 mr-2" />
              {isLoading ? "Logging in..." : "Login"}
            </Button>
          </form>

          <p className="text-xs text-slate-500 text-center mt-6">
            Admin access only. Unauthorized access is prohibited.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
