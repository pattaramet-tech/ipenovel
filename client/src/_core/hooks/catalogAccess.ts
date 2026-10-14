export function isCatalogOperatorRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "author";
}

export type CatalogFetchState = "loading" | "unauthenticated" | "forbidden" | "error" | "allowed";

/** Whether a self-scoped catalog query may run. Admin pages keep resolveAdminAccessState. */
export function resolveCatalogFetchState(params: {
  loading: boolean;
  user: { role?: string | null } | null | undefined;
  authMeError?: unknown;
}): CatalogFetchState {
  if (params.loading) return "loading";
  if (params.user) return isCatalogOperatorRole(params.user.role) ? "allowed" : "forbidden";
  if (params.authMeError) return "error";
  return "unauthenticated";
}
