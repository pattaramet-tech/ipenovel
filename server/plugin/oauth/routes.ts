import type { Express, Request, Response } from "express";
import { isAnonymousCredentialError } from "../../_core/authErrors";
import { getPluginOAuthTransientCookieOptions, readCookie } from "../../_core/cookies";
import { ENV, isPluginFoundationActive } from "../../_core/env";
import { safeErrorSummary } from "../../../scripts/lib/safeErrorSummary.mjs";
import { sdk } from "../../_core/sdk";
import { PLUGIN_PERMISSION_SCOPES, type PluginAuditSink, type PluginPermissionScope } from "../controlPlane";
import { createDbPluginAuditSink, newPluginCorrelationId } from "../audit";
import { escapePluginHtml, sendPluginOAuthError } from "../errors";
import { defaultLoadUserDisplay, defaultWorkspaceToolDeps, dispatchPluginMcpRequest } from "../mcp/protocol";
import {
  authenticatePluginBearer,
  beginPluginAuthorization,
  decidePluginConsent,
  exchangePluginAuthorizationCode,
  extractPluginClientCredentials,
  refreshPluginTokens,
  revokePluginToken,
} from "./service";

// IPE-PLUGIN-001B HTTP surface - /api/plugin/*.
//
// Every route fails closed: unless PLUGIN_FOUNDATION_ENABLED is exactly
// "true" (see server/_core/env.ts), each handler answers a plain 404 and
// the whole namespace is indistinguishable from not existing. Registered
// unconditionally in server/_core/index.ts (same pattern as the Google
// sign-in routes), so a flag flip needs no redeploy.

export const PLUGIN_CONSENT_CSRF_COOKIE = "plugin_oauth_consent_csrf";

const PLUGIN_OAUTH_AUTHORIZE_PATH = "/api/plugin/oauth/authorize";
const PLUGIN_OAUTH_CONSENT_PATH = "/api/plugin/oauth/authorize/consent";
const PLUGIN_OAUTH_TOKEN_PATH = "/api/plugin/oauth/token";
const PLUGIN_OAUTH_REVOKE_PATH = "/api/plugin/oauth/revoke";
const PLUGIN_WELL_KNOWN_PATH = "/.well-known/oauth-authorization-server";
const PLUGIN_MCP_PATH = "/api/plugin/mcp";

/** Exact route path inventory - asserted by the static surface tests. */
export const PLUGIN_ROUTE_PATHS = [
  PLUGIN_OAUTH_AUTHORIZE_PATH,
  PLUGIN_OAUTH_CONSENT_PATH,
  PLUGIN_OAUTH_TOKEN_PATH,
  PLUGIN_OAUTH_REVOKE_PATH,
  PLUGIN_WELL_KNOWN_PATH,
  PLUGIN_MCP_PATH,
] as const;

export function buildPluginAuthorizationServerMetadata(baseUrl: string): object {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/plugin/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/plugin/oauth/token`,
    revocation_endpoint: `${baseUrl}/api/plugin/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: [...PLUGIN_PERMISSION_SCOPES],
  };
}

function textParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function bodyParam(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function notFound(res: Response): void {
  res.status(404).end();
}

/**
 * The consent page - deliberately tiny, dependency-free HTML. Every dynamic
 * value is either a server-generated hidden field or the escaped client
 * name; user-facing strings are fixed (Thai, matching the site).
 */
export function renderPluginConsentPage(input: {
  clientName: string;
  scopes: readonly PluginPermissionScope[];
  state: string;
  csrfToken: string;
}): string {
  const scopeList = input.scopes.map(s => `<li>${escapePluginHtml(s)}</li>`).join("");
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ยืนยันการเชื่อมต่อแอปพลิเคชัน</title>
</head>
<body>
<h1>ยืนยันการเชื่อมต่อแอปพลิเคชัน</h1>
<p>แอปพลิเคชัน <strong>${escapePluginHtml(input.clientName)}</strong> ขอสิทธิ์เข้าถึงบัญชี IpeNovel ของคุณดังนี้:</p>
<ul>${scopeList}</ul>
<p>สิทธิ์เหล่านี้เป็นแบบอ่านอย่างเดียว และคุณสามารถเพิกถอนได้ทุกเมื่อ</p>
<form method="post" action="${PLUGIN_OAUTH_CONSENT_PATH}">
<input type="hidden" name="state" value="${escapePluginHtml(input.state)}">
<input type="hidden" name="csrfToken" value="${escapePluginHtml(input.csrfToken)}">
<button type="submit" name="decision" value="approve">อนุญาต</button>
<button type="submit" name="decision" value="deny">ปฏิเสธ</button>
</form>
</body>
</html>`;
}

function renderPluginErrorPage(message: string): string {
  return `<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><title>เกิดข้อผิดพลาด</title></head>
<body><p>${escapePluginHtml(message)}</p></body>
</html>`;
}

export function registerPluginFoundationRoutes(app: Express) {
  const auditSink: PluginAuditSink = createDbPluginAuditSink();

  // ------------------------------------------------------------------
  // GET /api/plugin/oauth/authorize - session-authenticated browser step.
  // ------------------------------------------------------------------
  app.get(PLUGIN_OAUTH_AUTHORIZE_PATH, (req: Request, res: Response) => {
    void (async () => {
      if (!isPluginFoundationActive()) return notFound(res);
      try {
        const user = await sdk.authenticateRequest(req);
        const attempt = await beginPluginAuthorization({
          clientId: textParam(req, "client_id"),
          redirectUri: textParam(req, "redirect_uri"),
          responseType: textParam(req, "response_type"),
          responseMode: textParam(req, "response_mode"),
          state: textParam(req, "state"),
          scope: textParam(req, "scope"),
          codeChallenge: textParam(req, "code_challenge"),
          codeChallengeMethod: textParam(req, "code_challenge_method"),
          userId: user.id,
          now: new Date(),
        });

        res.cookie(PLUGIN_CONSENT_CSRF_COOKIE, attempt.csrfToken, getPluginOAuthTransientCookieOptions(req));
        res.status(200).type("html").send(
          renderPluginConsentPage({
            clientName: attempt.clientName,
            scopes: attempt.scopes,
            state: attempt.state,
            csrfToken: attempt.csrfToken,
          })
        );
      } catch (error) {
        if (isAnonymousCredentialError(error)) {
          res.status(401).type("html").send(renderPluginErrorPage("กรุณาเข้าสู่ระบบก่อนเชื่อมต่อแอปพลิเคชัน"));
          return;
        }
        console.error("[plugin-oauth] authorize failed:", safeErrorSummary(error));
        sendPluginOAuthError(res, error);
      }
    })();
  });

  // ------------------------------------------------------------------
  // POST /api/plugin/oauth/authorize/consent - the consent decision.
  // ------------------------------------------------------------------
  app.post(PLUGIN_OAUTH_CONSENT_PATH, (req: Request, res: Response) => {
    void (async () => {
      if (!isPluginFoundationActive()) return notFound(res);
      try {
        const user = await sdk.authenticateRequest(req);
        const outcome = await decidePluginConsent({
          state: typeof bodyParam(req.body, "state") === "string" ? (bodyParam(req.body, "state") as string) : undefined,
          csrfToken:
            (typeof bodyParam(req.body, "csrfToken") === "string"
              ? (bodyParam(req.body, "csrfToken") as string)
              : undefined) ?? readCookie(req, PLUGIN_CONSENT_CSRF_COOKIE),
          decision: typeof bodyParam(req.body, "decision") === "string" ? (bodyParam(req.body, "decision") as string) : undefined,
          userId: user.id,
          now: new Date(),
          auditSink,
        });
        res.clearCookie(PLUGIN_CONSENT_CSRF_COOKIE, { ...getPluginOAuthTransientCookieOptions(req), maxAge: -1 });
        res.redirect(302, outcome.redirectUrl);
      } catch (error) {
        if (isAnonymousCredentialError(error)) {
          res.status(401).type("html").send(renderPluginErrorPage("กรุณาเข้าสู่ระบบก่อนเชื่อมต่อแอปพลิเคชัน"));
          return;
        }
        console.error("[plugin-oauth] consent failed:", safeErrorSummary(error));
        if (req.accepts("html")) {
          res.status(400).type("html").send(renderPluginErrorPage("คำขอเชื่อมต่อไม่ถูกต้องหรือหมดอายุ กรุณาเริ่มใหม่อีกครั้ง"));
          return;
        }
        sendPluginOAuthError(res, error);
      }
    })();
  });

  // ------------------------------------------------------------------
  // POST /api/plugin/oauth/token - confidential-client token endpoint.
  // ------------------------------------------------------------------
  app.post(PLUGIN_OAUTH_TOKEN_PATH, (req: Request, res: Response) => {
    void (async () => {
      if (!isPluginFoundationActive()) return notFound(res);
      try {
        const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
        const clientAuth = extractPluginClientCredentials(
          req,
          bodyParam(req.body, "client_id"),
          bodyParam(req.body, "client_secret")
        );
        const input = { body, clientAuth, now: new Date(), auditSink };

        const grantType = typeof body.grant_type === "string" ? body.grant_type : undefined;
        const grant =
          grantType === "refresh_token"
            ? await refreshPluginTokens(input)
            : await exchangePluginAuthorizationCode(input);

        res.status(200).json({
          access_token: grant.accessToken,
          token_type: grant.tokenType,
          expires_in: grant.expiresIn,
          refresh_token: grant.refreshToken,
          scope: grant.scope,
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === "PluginOAuthError")) {
          console.error("[plugin-oauth] token endpoint failed:", safeErrorSummary(error));
        }
        sendPluginOAuthError(res, error);
      }
    })();
  });

  // ------------------------------------------------------------------
  // POST /api/plugin/oauth/revoke - RFC 7009.
  // ------------------------------------------------------------------
  app.post(PLUGIN_OAUTH_REVOKE_PATH, (req: Request, res: Response) => {
    void (async () => {
      if (!isPluginFoundationActive()) return notFound(res);
      try {
        const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
        const clientAuth = extractPluginClientCredentials(
          req,
          bodyParam(req.body, "client_id"),
          bodyParam(req.body, "client_secret")
        );
        await revokePluginToken({ body, clientAuth, now: new Date(), auditSink });
        // RFC 7009 §2.2: always 200, even for unknown tokens.
        res.status(200).json({});
      } catch (error) {
        if (!(error instanceof Error && error.name === "PluginOAuthError")) {
          console.error("[plugin-oauth] revoke endpoint failed:", safeErrorSummary(error));
        }
        sendPluginOAuthError(res, error);
      }
    })();
  });

  // ------------------------------------------------------------------
  // GET /.well-known/oauth-authorization-server - RFC 8414 metadata.
  // ------------------------------------------------------------------
  app.get(PLUGIN_WELL_KNOWN_PATH, (_req: Request, res: Response) => {
    if (!isPluginFoundationActive()) return notFound(res);
    if (!ENV.pluginPublicBaseUrl) return notFound(res);
    res.status(200).json(buildPluginAuthorizationServerMetadata(ENV.pluginPublicBaseUrl));
  });

  // ------------------------------------------------------------------
  // POST /api/plugin/mcp - JSON-RPC 2.0 transport skeleton (bearer-gated).
  // ------------------------------------------------------------------
  app.post(PLUGIN_MCP_PATH, (req: Request, res: Response) => {
    void (async () => {
      if (!isPluginFoundationActive()) return notFound(res);
      try {
        const principal = await authenticatePluginBearer(req.headers.authorization, new Date());
        if (!principal) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="ipenovel-plugin", scope="identity:read"');
          res.status(401).json({ error: "unauthorized" });
          return;
        }

        const outcome = await dispatchPluginMcpRequest(req.body, principal, principal.scopes, {
          auditSink,
          now: () => new Date(),
          loadUserDisplay: defaultLoadUserDisplay,
          workspaceTools: defaultWorkspaceToolDeps(),
        });
        if (outcome.kind === "notification_accepted") {
          res.status(202).end();
          return;
        }
        res.status(outcome.status).json(outcome.body);
      } catch (error) {
        console.error("[plugin-mcp] request failed:", safeErrorSummary(error));
        res.status(500).json({ error: "server_error" });
      }
    })();
  });
}
