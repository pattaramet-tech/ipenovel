import type { User } from "../../drizzle/schema";
import * as db from "../db";

/** Fixed code exposed through tRPC's sanitized authGateCode allowlist. */
export const ACCOUNT_MERGED_RELOGIN_REQUIRED_CODE =
  "ACCOUNT_MERGED_RELOGIN_REQUIRED";

/** Fixed client-safe message. Never includes Source/Target ids, email, or Google subject. */
export const ACCOUNT_MERGED_RELOGIN_REQUIRED_MESSAGE =
  "This account has been merged. Sign out and sign in with Google again to continue with the merged account.";

/**
 * A completed Advanced Account Merge retains the Source user row/openId for
 * historical integrity, so an already-issued Source JWT can still resolve to
 * that row. This check is the server-authoritative stale-session boundary:
 * completed Sources may read the explicit auth status/logout endpoints, but
 * must never perform a business write or reconnect a new Google identity.
 */
export async function isCompletedAccountMergeSource(
  user: Pick<User, "id" | "role">
): Promise<boolean> {
  // Admin users are forbidden from participating as Source/Target by the
  // merge safety rules, so skip the lookup entirely for admin sessions.
  if (user.role === "admin") return false;
  return Boolean(await db.getCompletedAccountMergeForSource(user.id));
}
