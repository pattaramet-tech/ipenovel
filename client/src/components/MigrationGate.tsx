import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import {
  isMandatoryGoogleConnectionEnabled,
  isMigrationGateExemptPath,
  resolveMigrationGateAction,
} from "@/_core/hooks/migrationGate";

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
  const { isAuthenticated, loading: authLoading } = useAuth();

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

  return <>{children}</>;
}
