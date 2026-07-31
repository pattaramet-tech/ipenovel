import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { isGoogleConnectionMandatory } from "./env";

// Central enforcement point for the mandatory Google-connection migration
// gate (AUTH_PROVIDER=transition + AUTH_REQUIRE_GOOGLE_CONNECTION=true) -
// wired into server/_core/trpc.ts's protectedProcedure so every existing
// and future "business action" procedure is covered by construction,
// without needing to individually edit each router file. See
// client/src/hooks/migrationGate.ts for the client-side counterpart (a
// route-level redirect) - that one is a UX convenience only; THIS is the
// actual security boundary, since a client redirect can always be bypassed
// by calling the API directly.

/** The `cause.code` this gate's TRPCError carries - server/_core/trpc.ts's sanitizeTrpcErrorShape allowlists exactly this literal into a client-readable `data.authGateCode`, so the client can distinguish "you must connect Google" from any other FORBIDDEN without parsing the (translatable, UI-owned) message text. */
export const GOOGLE_CONNECTION_REQUIRED_CODE = "GOOGLE_CONNECTION_REQUIRED";

/** Fixed, safe, translated message - never includes the user's id, email, Google sub, or any other internal detail. */
export const GOOGLE_CONNECTION_REQUIRED_MESSAGE =
  "กรุณาเชื่อมบัญชี Google กับบัญชีเดิมของคุณก่อนใช้งานส่วนนี้";

/**
 * Whether `user` is currently blocked by the mandatory Google-migration
 * gate. Returns false immediately (no database read at all) whenever the
 * gate itself isn't active (isGoogleConnectionMandatory() false) - so this
 * adds zero overhead to every request in manus/google mode, and in
 * transition mode with the flag off.
 *
 * Takes an already-authenticated user as input (never re-derives or
 * re-verifies it) - the caller (trpc.ts's protectedProcedure middleware)
 * is responsible for that. This function's only job is the ONE additional
 * question: does this already-authenticated user have a connected Google
 * identity yet?
 */
export async function isBlockedByGoogleMigrationGate(user: Pick<User, "id">): Promise<boolean> {
  if (!isGoogleConnectionMandatory()) return false;
  const identity = await db.getAuthIdentityByUserAndProvider(user.id, "google");
  return !identity;
}
