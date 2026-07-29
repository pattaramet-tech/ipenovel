import { TRPCClientError } from "@trpc/client";

/**
 * Classifies a failed `auth.logout` mutation call. Pure - takes the caught
 * error, returns a label, performs no side effects (no cache writes, no
 * navigation).
 *
 * - "already_logged_out": the server says there was no session to clear
 *   (UNAUTHORIZED). This is not a failure from the caller's perspective -
 *   the end state ("no session") is exactly what logging out was trying to
 *   achieve, so useAuth's logout() treats it the same as a genuine success.
 * - "unexpected_error": anything else - a network failure, a 5xx, a
 *   timeout. The session might still be valid server-side; the caller must
 *   NOT force the local auth.me cache to null or navigate away on this
 *   outcome, or a transient network blip would look exactly like "you got
 *   logged out," which is worse than just leaving the stale session in
 *   place and letting the user retry.
 */
export type LogoutFailureOutcome = "already_logged_out" | "unexpected_error";

export function classifyLogoutFailure(error: unknown): LogoutFailureOutcome {
  if (error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED") {
    return "already_logged_out";
  }
  return "unexpected_error";
}
