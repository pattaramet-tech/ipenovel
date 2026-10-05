import type { Response } from "express";

// Deterministic, sanitized error surface for the plugin foundation.
//
// Discipline (matching server/_core/trpc.ts's errorFormatter and the NQA
// gateway's fixed error codes): a caller - an unauthenticated HTTP client -
// may only ever see a FIXED, constant string from an allowlist below. Raw
// database messages, stack traces, token material, and anything derived
// from a request body are never echoed. Unexpected internal failures are
// logged server-side via safeErrorSummary by the route layer and answered
// with the one generic SERVER_ERROR code.

/** RFC 6749 §5.2 token-endpoint error codes + RFC 7009 §2.2.1 additions. */
export const PLUGIN_OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_token_type",
  "invalid_scope",
  "server_error",
] as const;

export type PluginOAuthErrorCode = (typeof PLUGIN_OAUTH_ERROR_CODES)[number];

/** Fixed, constant description per code - never interpolates request data. */
const PLUGIN_OAUTH_ERROR_DESCRIPTIONS: Record<PluginOAuthErrorCode, string> = {
  invalid_request: "The request is missing a required parameter or is otherwise malformed.",
  invalid_client: "Client authentication failed.",
  invalid_grant: "The provided authorization grant or credentials are invalid, expired, or revoked.",
  unauthorized_client: "The client is not authorized to use this grant type.",
  unsupported_grant_type: "The grant type is not supported.",
  unsupported_token_type: "The token type hint is not supported.",
  invalid_scope: "The requested scope is invalid, unknown, or malformed.",
  server_error: "The authorization server encountered an unexpected condition.",
};

export class PluginOAuthError extends Error {
  readonly code: PluginOAuthErrorCode;
  readonly httpStatus: number;

  constructor(code: PluginOAuthErrorCode, httpStatus = 400) {
    super(`plugin-oauth:${code}`);
    this.name = "PluginOAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
  }

  /** The only body this error is ever allowed to produce. */
  toResponseBody(): { error: PluginOAuthErrorCode; error_description: string } {
    return {
      error: this.code,
      error_description: PLUGIN_OAUTH_ERROR_DESCRIPTIONS[this.code],
    };
  }
}

export function pluginOAuthError(code: PluginOAuthErrorCode, httpStatus = 400): PluginOAuthError {
  return new PluginOAuthError(code, httpStatus);
}

/**
 * Maps any thrown value to a safe OAuth error response: known
 * PluginOAuthErrors keep their (already-sanitized) code; anything else
 * collapses to server_error/500. The caller is responsible for logging the
 * original with safeErrorSummary.
 */
export function toPluginOAuthErrorResponse(error: unknown): {
  status: number;
  body: { error: PluginOAuthErrorCode; error_description: string };
} {
  if (error instanceof PluginOAuthError) {
    return { status: error.httpStatus, body: error.toResponseBody() };
  }
  return { status: 500, body: new PluginOAuthError("server_error", 500).toResponseBody() };
}

export function sendPluginOAuthError(res: Response, error: unknown): void {
  const mapped = toPluginOAuthErrorResponse(error);
  res.status(mapped.status).json(mapped.body);
}

/**
 * Minimal HTML escaping for the consent page - the ONLY place plugin
 * routes render HTML. Client-supplied strings (client name, scope text)
 * are escaped before interpolation; every hidden field is server-generated.
 */
export function escapePluginHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
