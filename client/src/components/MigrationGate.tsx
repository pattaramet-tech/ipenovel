import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  isMandatoryGoogleConnectionEnabled,
  isMigrationGateExemptPath,
  resolveMigrationGateAction,
} from "@/_core/hooks/migrationGate";
import { resolveSupportUrl } from "@/pages/upgradeLoginPresentation";

/**
 * Global, App/Router-level UX gate for the mandatory Google-connection
 * migration (AUTH_PROVIDER=transition + VITE_AUTH_REQUIRE_GOOGLE_CONNECTION
 * ="true" - see client/src/_core/hooks/migrationGate.ts for the pure
 * decision logic this component only wires up to real hooks/routing).
 *
 * This is UX convenience only, never the security boundary - a client
 * redirect can always be bypassed by calling the API directly. The real
 * enforcement is server/_core/googleMigrationGate.ts, centrally wired into
 * every protectedProcedure. Do not remove this component under the
 * assumption the server-side gate alone is "enough" - a gated user who
 * never sees this redirect would otherwise hit a wall of opaque FORBIDDEN
 * errors instead of a clear explanation.
 */
export default function MigrationGate({ children }: { children: ReactNode }) {
  const [pathname, navigate] = useLocation();
  const { isAuthenticated, loading: authLoading, logout } = useAuth();

  const mandatoryEnabled = isMandatoryGoogleConnectionEnabled(
    import.meta.env.VITE_AUTH_PROVIDER,
    import.meta.env.VITE_AUTH_REQUIRE_GOOGLE_CONNECTION
  );

  // Never fires at all (zero extra network traffic) unless the gate is
  // actually active for this route - exempt paths (admin, /login,
  // /account/upgrade-login) and anonymous visitors never need this query.
  const shouldQuery = mandatoryEnabled && isAuthenticated && !isMigrationGateExemptPath(pathname);
  const googleConnectedQuery = trpc.auth.googleConnected.useQuery(undefined, { enabled: shouldQuery });

  const action = resolveMigrationGateAction({
    mandatoryEnabled,
    pathname,
    isAuthenticated,
    authLoading,
    googleConnected: googleConnectedQuery.data?.googleConnected,
    googleConnectedLoading: shouldQuery && googleConnectedQuery.isLoading,
    googleConnectedError: shouldQuery && googleConnectedQuery.isError,
  });

  useEffect(() => {
    if (action === "redirect_upgrade") {
      navigate("/account/upgrade-login", { replace: true });
    }
  }, [action, navigate]);

  if (action === "block_loading" || action === "redirect_upgrade") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" aria-hidden="true" />
      </div>
    );
  }

  if (action === "block_error") {
    // An infrastructure failure while checking Google-connection status -
    // must never fail open (silently let the visitor through), never guess
    // "not connected" and redirect to the upgrade page (that could be
    // wrong), and never show the raw error/database/API detail to the
    // browser. A fixed message plus a manual retry (refetch) and a logout
    // escape hatch are the only ways out of this screen.
    const supportUrl = resolveSupportUrl(import.meta.env.VITE_SUPPORT_URL);
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-12">
        <Card className="w-full max-w-md p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">ไม่สามารถตรวจสอบสถานะบัญชีได้</h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            เกิดข้อผิดพลาดชั่วคราว กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จ กรุณาติดต่อฝ่ายช่วยเหลือ
          </p>
          <div className="flex flex-col gap-3">
            <Button size="lg" className="w-full" onClick={() => googleConnectedQuery.refetch()}>
              ลองใหม่
            </Button>
            <Button variant="outline" size="lg" className="w-full" onClick={() => logout()}>
              ออกจากระบบ
            </Button>
            {supportUrl && (
              <Button asChild variant="ghost" size="sm" className="w-full">
                <a href={supportUrl} target="_blank" rel="noopener noreferrer">
                  ติดต่อฝ่ายช่วยเหลือ
                </a>
              </Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
