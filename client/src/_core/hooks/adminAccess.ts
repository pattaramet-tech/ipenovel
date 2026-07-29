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
export type AdminAccessState = "loading" | "unauthenticated" | "forbidden" | "allowed";

export interface ResolveAdminAccessStateParams {
  loading: boolean;
  user: { role?: string | null } | null | undefined;
}

export function resolveAdminAccessState({ loading, user }: ResolveAdminAccessStateParams): AdminAccessState {
  if (loading) return "loading";
  if (!user) return "unauthenticated";
  if (user.role !== "admin") return "forbidden";
  return "allowed";
}
