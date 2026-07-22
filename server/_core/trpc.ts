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
 * Sanitizes one tRPC error shape before it is serialized to the client.
 *
 * Exported so the exact function wired into `errorFormatter` below can be
 * unit-tested directly (errorFormatter only runs inside the HTTP adapter,
 * not for direct callers).
 *
 * - Intentional application errors (auth, validation, not-found, ...) keep
 *   their message, which is written by this codebase for the user.
 * - Everything else - notably INTERNAL_SERVER_ERROR, which is what an
 *   unhandled drizzle/mysql exception becomes - is replaced with a generic
 *   message. drizzle embeds the failing SQL and its bound parameters in the
 *   error message, so passing it through leaks schema shape and user data.
 * - A stack trace is never shipped, for any code.
 * - `cause` is never copied into the response.
 */
export function sanitizeTrpcErrorShape(shape: any, error: { code: string }, logger: Pick<Console, "error"> = console): any {
  const safeShape = {
    ...shape,
    data: { ...shape?.data, stack: undefined },
  };

  if (CLIENT_SAFE_ERROR_CODES.has(error.code)) {
    return safeShape;
  }

  // Unexpected failure: keep the real diagnostic server-side only, in
  // sanitized form (code/errno/sqlState plus the underlying driver message,
  // never SQL text or bound parameters).
  logger.error(`[trpc] ${error.code} on unexpected error: ${safeErrorSummary(error)}`);

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
