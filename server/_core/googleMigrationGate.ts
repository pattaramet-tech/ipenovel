import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { evaluateGoogleConnectionCutoff } from "./env";

// Central enforcement point for the mandatory/targeted Google-connection
// migration gate (AUTH_REQUIRE_GOOGLE_CONNECTION[_AFTER], active for
// AUTH_PROVIDER "transition" or "google" - see
// server/_core/env.ts's evaluateGoogleConnectionCutoff, the single source
// of truth for WHETHER the gate is active right now) - wired into
// server/_core/trpc.ts's protectedProcedure so every existing and future
// "business action" procedure is covered by construction, without needing
// to individually edit each router file. See
// client/src/_core/hooks/migrationGate.ts for the client-side counterpart
// (a route-level redirect) - that one is a UX convenience only; THIS is
// the actual security boundary, since a client redirect can always be
// bypassed by calling the API directly.

/** The `cause.code` this gate's TRPCError carries - server/_core/trpc.ts's sanitizeTrpcErrorShape allowlists exactly this literal into a client-readable `data.authGateCode`, so the client can distinguish "you must connect Google" from any other FORBIDDEN without parsing the (translatable, UI-owned) message text. */
export const GOOGLE_CONNECTION_REQUIRED_CODE = "GOOGLE_CONNECTION_REQUIRED";

/** Fixed, safe, translated message - never includes the user's id, email, Google sub, or any other internal detail. */
export const GOOGLE_CONNECTION_REQUIRED_MESSAGE =
  "กรุณาเชื่อมบัญชี Google กับบัญชีเดิมของคุณก่อนใช้งานส่วนนี้";

/**
 * Whether `user` is currently blocked by the Google-connection migration
 * gate. Returns false immediately (no database read at all) whenever the
 * gate itself isn't active right now - either the feature is off entirely,
 * or a targeted cutoff is configured and the server clock hasn't reached
 * it yet (evaluateGoogleConnectionCutoff().activeNow === false) - so this
 * adds zero overhead to every request before a scheduled cutoff arrives,
 * and in manus mode always (the gate can never be enabled there at all).
 *
 * Takes an already-authenticated user as input (never re-derives or
 * re-verifies it) - the caller (trpc.ts's protectedProcedure middleware)
 * is responsible for that. This function's only job is the ONE additional
 * question: does this already-authenticated user have a connected Google
 * identity yet? (Admin exemption is structural, not a role check here -
 * see routers.ts's local adminProcedure and server/_core/trpc.ts's own
 * adminProcedure, both built on authenticatedProcedure, never
 * protectedProcedure, so an admin-only procedure never reaches this
 * function at all.)
 */
export async function isBlockedByGoogleMigrationGate(user: Pick<User, "id">): Promise<boolean> {
  if (!evaluateGoogleConnectionCutoff().activeNow) return false;
  const identity = await db.getAuthIdentityByUserAndProvider(user.id, "google");
  return !identity;
}
