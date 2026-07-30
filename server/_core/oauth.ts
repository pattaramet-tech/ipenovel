import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { getSessionCookieOptions } from "./cookies";
import { isManusAuthActive } from "./env";
import { normalizeProviderName } from "./providerName";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    // Feature-flag guard, added for the Google OpenID Connect direct-login
    // flag (AUTH_PROVIDER). This route is reachable in "manus" (the
    // default) and "transition" (existing Manus users must keep being
    // able to sign in the old way while Google is also available - see
    // server/_core/env.ts's isManusAuthActive) - only AUTH_PROVIDER=google
    // (a full cutover) turns it off, responding 404 immediately, before
    // reading code/state, before any token exchange, before any database
    // access, before any session is ever minted. Every line of the
    // original Manus logic below this guard is otherwise completely
    // unchanged, kept in place for instant rollback (set AUTH_PROVIDER
    // back to "manus", or unset it).
    if (!isManusAuthActive()) {
      res.status(404).end();
      return;
    }

    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      // Confirmed available BEFORE the user is upserted or a session cookie
      // is minted - an outage here must never look like a successful
      // login (no upsert, no session token, no res.cookie(), no success
      // redirect). Propagates to the catch below, which already responds
      // with a safe generic error and never exposes database detail.
      await db.assertDatabaseAvailable();

      const normalizedName = normalizeProviderName(userInfo.name);

      await db.upsertUser({
        openId: userInfo.openId,
        // undefined (never null) when the provider sent no usable name, so
        // an existing stored name is never overwritten by an empty one on
        // a returning login - see normalizeProviderName.
        name: normalizedName ?? undefined,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: normalizedName,
        expiresInMs: SESSION_TTL_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: SESSION_TTL_MS });

      res.redirect(302, "/");
    } catch (error) {
      // Sanitized: an axios error here can carry the OAuth token-exchange
      // request/response - never log it raw.
      console.error("[OAuth] Callback failed:", safeErrorSummary(error));
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
