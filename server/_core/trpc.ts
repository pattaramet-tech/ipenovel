import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

/** Shown to the client for any error that was not deliberately raised by application code. */
export const GENERIC_INTERNAL_ERROR_MESSAGE = "Unable to process this request at this time. Please try again.";

/**
 * Error codes whose messages are written by this application on purpose and
 * are safe to show a user (validation failures, auth failures, missing
 * records). Every other code - most importantly INTERNAL_SERVER_ERROR, which
 * is what an unhandled database exception becomes - has its message replaced
 * with a generic one.
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
  const safeShape = {
    ...shape,
    data: { ...shape?.data, stack: undefined },
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

export const protectedProcedure = t.procedure.use(requireUser);

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
