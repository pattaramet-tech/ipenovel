import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import {
  GOOGLE_CONNECTION_REQUIRED_CODE,
  GOOGLE_CONNECTION_REQUIRED_MESSAGE,
  isBlockedByGoogleMigrationGate,
} from "./googleMigrationGate";

/** Shown to the client for any error that was not deliberately raised by application code. */
export const GENERIC_INTERNAL_ERROR_MESSAGE = "Unable to process this request at this time. Please try again.";

/**
 * Error codes whose messages are written by this application on purpose and
 * are safe to show a user (validation failures, auth failures, missing
 * records). Every other code - most importantly INTERNAL_SERVER_ERROR, which
 * is what an unhandled database exception becomes - has its message replaced
 * with a generic one.
 *
 * SERVICE_UNAVAILABLE is included because every existing caller of this code
 * (server/helpers/storageErrorHandler.ts, server/routers.ts's image/media
 * upload paths, server/services/slipFileUploadService.ts's payment-slip
 * upload path) throws it only for a deliberately classified, non-leaking
 * condition (storage not configured / storage temporarily unavailable) with
 * a fixed, hand-written Thai message - never a forwarded `.message`, stack
 * trace, or raw SDK/driver error. Before this was added, every one of those
 * messages was being silently replaced by GENERIC_INTERNAL_ERROR_MESSAGE
 * (the exact customer-visible symptom of the payment-slip-upload
 * regression this was fixed for) - see trpc.test.ts's regression coverage.
 * INTERNAL_SERVER_ERROR is deliberately NOT added: unlike SERVICE_UNAVAILABLE,
 * it is Node/tRPC's own default for any uncaught exception (including a raw
 * database error), so most of its current uses are NOT deliberately-safe
 * messages - keeping it excluded is what makes the generic-message fallback
 * meaningful at all.
 */
const CLIENT_SAFE_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "TOO_MANY_REQUESTS",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_CONTENT",
  "PRECONDITION_FAILED",
  "METHOD_NOT_SUPPORTED",
  "SERVICE_UNAVAILABLE",
]);

/**
 * True when `message` carries one of drizzle/mysql's own unmistakable leak
 * signatures - not a general SQL-keyword scan (bare words like "select",
 * "update", or "delete" appear constantly in ordinary English messages,
 * e.g. "Please select a payment method" or "Please update your address",
 * and would false-positive there), but the specific literal markers
 * drizzle-orm actually emits:
 *
 *   Failed query: select `id`, `userId` from `dailyCheckins` where ...
 *   params: 2160001,1
 *
 * This exists as defense-in-depth for a real gap: several existing
 * catch blocks in server/routers.ts rethrow a caught error's own
 * `.message` wrapped in an allowlisted code, e.g.
 * `throw new TRPCError({ code: "BAD_REQUEST", message: error?.message })`.
 * If the caught error ever turns out to be a raw, unwrapped drizzle
 * exception (a DB error inside orderService.approvePayment/rejectPayment,
 * for instance) rather than the deliberately-thrown application error
 * those call sites assume, `sanitizeTrpcErrorShape` must not trust the
 * "safe" code blindly - the message itself needs to be checked too.
 */
export function looksLikeRawDatabaseError(message: unknown): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  if (/failed\s+query/i.test(message)) return true;
  if (/\bparams\s*:/i.test(message)) return true;
  // drizzle/mysql render identifiers backtick-quoted - a SQL keyword
  // immediately followed by a backtick is not something a hand-written
  // English message would ever produce.
  if (/\b(select|insert|update|delete|create|alter|drop)\s*`/i.test(message)) return true;
  // A raw connection string, with or without embedded credentials.
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+@/i.test(message)) return true;
  return false;
}

/**
 * Sanitizes one tRPC error shape before it is serialized to the client.
 *
 * Exported so the exact function wired into `errorFormatter` below can be
 * unit-tested directly (errorFormatter only runs inside the HTTP adapter,
 * not for direct callers).
 *
 * - Intentional application errors (auth, validation, not-found, ...) keep
 *   their message, which is written by this codebase for the user - UNLESS
 *   the message itself looks like a raw drizzle/mysql exception (see
 *   looksLikeRawDatabaseError), in which case it is treated exactly like an
 *   unexpected error regardless of its code. A "safe" code is not, by
 *   itself, proof the message was hand-written by application code.
 * - Everything else - notably INTERNAL_SERVER_ERROR, which is what an
 *   unhandled drizzle/mysql exception normally becomes - is replaced with a
 *   generic message. drizzle embeds the failing SQL and its bound
 *   parameters in the error message, so passing it through leaks schema
 *   shape and user data.
 * - A stack trace is never shipped, for any code.
 * - `cause` is never copied into the response.
 */
export function sanitizeTrpcErrorShape(shape: any, error: { code: string }, logger: Pick<Console, "error"> = console): any {
  const causeCode = (error as any)?.cause?.code;
  const safeCauseCode =
    causeCode === "CHECKOUT_MAINTENANCE" || causeCode === "SLIP_PAYMENT_MAINTENANCE"
      ? causeCode
      : undefined;
  // Lets the client distinguish "you must connect Google" from any other
  // FORBIDDEN (e.g. NOT_ADMIN_ERR_MSG) without parsing the human-readable
  // (Thai, UI-owned) message text - see googleMigrationGate.ts. Never
  // carries anything beyond this one fixed literal - no userId, email, or
  // Google sub is ever attached to this error's cause.
  const safeAuthGateCode = causeCode === GOOGLE_CONNECTION_REQUIRED_CODE ? causeCode : undefined;
  const safeShape = {
    ...shape,
    data: { ...shape?.data, stack: undefined, maintenanceCode: safeCauseCode, authGateCode: safeAuthGateCode },
  };

  const rawMessage = shape?.message ?? (error as any)?.message;
  const isSafeCode = CLIENT_SAFE_ERROR_CODES.has(error.code);
  const isDisguisedDatabaseError = looksLikeRawDatabaseError(rawMessage);

  if (isSafeCode && !isDisguisedDatabaseError) {
    return safeShape;
  }

  // Unexpected failure (or a database error disguised behind a "safe"
  // code): keep the real diagnostic server-side only, in sanitized form
  // (code/errno/sqlState plus the underlying driver message, never SQL
  // text or bound parameters).
  logger.error(
    `[trpc] ${error.code}${isDisguisedDatabaseError ? " (raw DB error behind an allowlisted code)" : ""} on unexpected error: ${safeErrorSummary(error)}`
  );

  return {
    ...safeShape,
    message: GENERIC_INTERNAL_ERROR_MESSAGE,
    data: {
      ...safeShape.data,
      message: GENERIC_INTERNAL_ERROR_MESSAGE,
    },
  };
}

// Global tRPC error sanitization. Previously there was no errorFormatter at
// all, so an unhandled database exception was serialized to the browser with
// drizzle's full message - including "Failed query: select ... from
// dailyCheckins" and "params: <real user ids>". Applying this centrally
// (rather than per-procedure) covers every current and future procedure by
// construction.
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => sanitizeTrpcErrorShape(shape, error),
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * Requires only that a real session is attached (ctx.user is non-null) -
 * NOT the mandatory Google-migration gate below. This is the procedure
 * type for the small, explicit allowlist of things a signed-in-but-not-yet-
 * Google-connected user must still be able to call: auth.googleConnected
 * (the query the gate itself depends on - it would be a deadlock if this
 * were gated), auth.logout, auth.me, and any admin-only procedure (see
 * routers.ts's local adminProcedure, which is now built on THIS, not on
 * protectedProcedure below, specifically so an admin action is never
 * blocked by a customer-facing migration gate).
 */
export const authenticatedProcedure = t.procedure.use(requireUser);

const requireGoogleMigrationComplete = t.middleware(async opts => {
  const { ctx, next } = opts;

  // Unreachable in practice - this middleware is only ever chained after
  // authenticatedProcedure's requireUser (see protectedProcedure below),
  // which already guarantees ctx.user is non-null. Kept as an explicit
  // check (rather than a non-null assertion) purely so TypeScript can
  // prove it below without one - t.middleware is defined standalone, so
  // its own inferred ctx type doesn't know about whatever it's later
  // chained onto.
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // isBlockedByGoogleMigrationGate itself no-ops (returns false, no
  // database read) whenever the gate isn't active, so this is a zero-cost
  // no-op in manus/google mode.
  if (await isBlockedByGoogleMigrationGate(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: GOOGLE_CONNECTION_REQUIRED_MESSAGE,
      cause: { code: GOOGLE_CONNECTION_REQUIRED_CODE },
    });
  }

  // Re-asserts ctx.user (already non-null here, narrowed by
  // authenticatedProcedure's requireUser) the same way requireUser itself
  // does - without this, TypeScript's inference for this middleware's
  // output context widens ctx.user back to nullable for every downstream
  // protectedProcedure, which is exactly the class of error this narrowing
  // trick exists to prevent (a compile-time guarantee, not just a runtime
  // check, that a protectedProcedure handler can use ctx.user.id directly).
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * The procedure type for ordinary signed-in "business actions" (bookshelf,
 * wallet, points, orders, payments, purchases, wishlist, reading a
 * member-only episode, editing profile data, ...). Built on
 * authenticatedProcedure (auth already required) plus the mandatory
 * Google-migration gate - so EVERY router that already used
 * protectedProcedure is covered by this central middleware automatically,
 * with no per-router edits needed. Anything that must remain reachable
 * even while a user is gated (see authenticatedProcedure's docstring) must
 * use authenticatedProcedure instead, never this one.
 */
export const protectedProcedure = authenticatedProcedure.use(requireGoogleMigrationComplete);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
