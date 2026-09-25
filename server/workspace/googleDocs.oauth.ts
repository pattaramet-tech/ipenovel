import type { Express, Request, Response } from "express";
import { isAnonymousCredentialError } from "../_core/authErrors";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { sdk } from "../_core/sdk";
import { getDb } from "../db";
import { WorkspaceAdminAccessError, requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  hasRequiredDocsScopes,
  WORKSPACE_DOCS_CALLBACK_PATH,
} from "./googleDocs.domain";
import {
  consumeGoogleConsentAttempt,
  createGoogleConsentAttempt,
  saveGoogleConnection,
} from "./googleDocs.service";
import {
  workspaceGoogleDocsOAuthConfig,
  workspaceGoogleDocsTokenCipher,
} from "./googleDocs.runtime";

const SUCCESS_REDIRECT = "/workspace?googleDocsConnect=success";
const ERROR_REDIRECT = "/workspace?googleDocsConnect=error";
const SESSION_EXPIRED_REDIRECT = "/login?googleDocsConnect=session_expired";

function queryParam(req: Request, name: string) {
  const value = req.query[name];
  return typeof value === "string" ? value : "";
}

async function requireWorkspaceAdmin(req: Request) {
  const user = await sdk.authenticateRequest(req);
  const db = await getDb();
  if (!db) throw new Error("Workspace database is unavailable.");
  await requireWorkspacePlatformAdmin(db, user.id);
  return user;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<any> {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function exchangeWorkspaceGoogleDocsAuthorizationCode(
  input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
  },
  fetchImpl: typeof fetch = fetch
) {
  const token = await fetchJson(fetchImpl, input.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    }).toString(),
  });

  const accessToken =
    typeof token?.access_token === "string" ? token.access_token.trim() : "";
  const refreshToken =
    typeof token?.refresh_token === "string" ? token.refresh_token.trim() : "";
  const grantedScopes =
    typeof token?.scope === "string" ? token.scope.trim() : "";

  if (!accessToken || !refreshToken) {
    throw new Error("Google OAuth response did not include durable credentials.");
  }
  if (!hasRequiredDocsScopes(grantedScopes)) {
    throw new Error("Google OAuth response is missing required read-only Docs scopes.");
  }

  const profile = await fetchJson(fetchImpl, input.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const providerSubject =
    typeof profile?.sub === "string" ? profile.sub.trim() : "";
  if (!providerSubject) {
    throw new Error("Google userinfo response did not include a subject.");
  }

  return { providerSubject, refreshToken, grantedScopes };
}

function redirectResult(res: Response, destination: string) {
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, destination);
}

export function registerWorkspaceGoogleDocsOAuthRoutes(app: Express) {
  app.get("/api/workspace/google/start", async (req, res) => {
    try {
      const user = await requireWorkspaceAdmin(req);
      const config = workspaceGoogleDocsOAuthConfig();
      const consent = await createGoogleConsentAttempt({
        userId: user.id,
        authorizationEndpoint: config.authorizationEndpoint,
        clientId: config.clientId,
        fixedRedirectUri: config.redirectUri,
        cipher: workspaceGoogleDocsTokenCipher(),
      });
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, consent.authorizationUrl);
    } catch (error) {
      if (isAnonymousCredentialError(error)) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      if (error instanceof WorkspaceAdminAccessError) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      console.error(
        `[workspace-google-docs] start failed: ${safeErrorSummary(error)}`
      );
      res.status(500).json({ error: "Google Docs connection is unavailable" });
    }
  });

  app.get(WORKSPACE_DOCS_CALLBACK_PATH, async (req, res) => {
    if (queryParam(req, "error")) {
      redirectResult(res, ERROR_REDIRECT);
      return;
    }

    try {
      const user = await requireWorkspaceAdmin(req);
      const state = queryParam(req, "state");
      const code = queryParam(req, "code");
      if (!state || !code) throw new Error("Google callback is missing state or code.");

      const cipher = workspaceGoogleDocsTokenCipher();
      const attempt = await consumeGoogleConsentAttempt({
        userId: user.id,
        state,
        cipher,
      });
      const config = workspaceGoogleDocsOAuthConfig();
      if (attempt.fixedRedirectUri !== config.redirectUri) {
        throw new Error("Workspace Google Docs redirect configuration changed during consent.");
      }

      const exchanged = await exchangeWorkspaceGoogleDocsAuthorizationCode({
        code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: attempt.fixedRedirectUri,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        tokenEndpoint: config.tokenEndpoint,
        userInfoEndpoint: config.userInfoEndpoint,
      });

      await saveGoogleConnection({
        userId: user.id,
        providerSubject: exchanged.providerSubject,
        credential: cipher.encrypt(exchanged.refreshToken),
        grantedScopes: exchanged.grantedScopes,
      });
      redirectResult(res, SUCCESS_REDIRECT);
    } catch (error) {
      if (isAnonymousCredentialError(error)) {
        redirectResult(res, SESSION_EXPIRED_REDIRECT);
        return;
      }
      console.error(
        `[workspace-google-docs] callback failed: ${safeErrorSummary(error)}`
      );
      redirectResult(res, ERROR_REDIRECT);
    }
  });
}
