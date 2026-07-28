import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { getSessionCookieOptions } from "./cookies";
import { normalizeProviderName } from "./providerName";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
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
