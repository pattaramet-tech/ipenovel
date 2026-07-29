/**
 * The single rule for whether an /admin/* route may render admin content or
 * fetch admin data, shared by AdminLayout (the render gate) and
 * AdminDashboard (which uses it only to decide whether its own queries may
 * run). Before this existed, each of those two places computed admin access
 * independently - AdminDashboard additionally trusted a `admin-session`
 * localStorage flag that `auth.me` never confirmed - so they could disagree
 * about whether the current visitor was actually an admin. Pure and
 * side-effect-free: never reads window/document/localStorage/sessionStorage
 * or a cookie directly. The only inputs are what `useAuth()` itself already
 * resolved from the HttpOnly session cookie via `auth.me` (server-verified,
 * re-checked against the database on every request - see
 * server/_core/sdk.ts's authenticateRequest).
 */
export type AdminAccessState = "loading" | "unauthenticated" | "forbidden" | "error" | "allowed";

export interface ResolveAdminAccessStateParams {
  loading: boolean;
  user: { role?: string | null } | null | undefined;
  /**
   * Specifically `auth.me`'s own query error (an infrastructure failure -
   * database down, network error, unexpected 5xx) - NEVER a logout
   * mutation's error. A logout failure says nothing about whether the
   * CURRENT session is valid, so it must never flip the access state to
   * "error" (which disables admin queries and blocks the login form) just
   * because a Logout click happened to fail. Truthy (any non-null/
   * undefined value) means "auth.me could not be resolved."
   */
  authMeError?: unknown;
}

export function resolveAdminAccessState({
  loading,
  user,
  authMeError,
}: ResolveAdminAccessStateParams): AdminAccessState {
  if (loading) return "loading";
  if (authMeError) return "error";
  if (!user) return "unauthenticated";
  if (user.role !== "admin") return "forbidden";
  return "allowed";
}
