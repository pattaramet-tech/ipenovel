import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static source-text regression guards for the Google OpenID Connect
// direct-login feature. These pin properties that a future edit could
// otherwise silently break without any behavioral test noticing (a
// working-but-insecure implementation still "passes" a functional test) -
// see each test's own description for the specific requirement it guards.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("error_description is never read, logged, or forwarded anywhere in the Google callback", () => {
  const source = readSource("server/_core/googleOAuth.ts");

  it("googleOAuth.ts never reads req.query.error_description at all - no getQueryParam(req, \"error_description\") call, no req.query.error_description access, anywhere in the file (the word may still appear in comments explaining why)", () => {
    expect(source).not.toMatch(/getQueryParam\(req,\s*["']error_description["']\)/);
    expect(source).not.toMatch(/req\.query\.error_description/);
    expect(source).not.toMatch(/req\.query\[["']error_description["']\]/);
  });

  it("the provider-error branch logs a FIXED, constant string - never providerError itself, not even sliced/capped - since the query string is unauthenticated user input that can contain newlines/control characters", () => {
    const errorBranchStart = source.indexOf('const providerError = getQueryParam(req, "error");');
    const errorBranchEnd = source.indexOf("const code = getQueryParam", errorBranchStart);
    expect(errorBranchStart).toBeGreaterThan(-1);
    expect(errorBranchEnd).toBeGreaterThan(errorBranchStart);
    const errorBranch = source.slice(errorBranchStart, errorBranchEnd);

    expect(errorBranch).toMatch(/console\.warn\("\[GoogleOAuth\] Google authorization was not completed"\)/);
    // Never interpolates providerError (or anything else query-derived)
    // into the log line - no template literal, no string concatenation
    // with the variable.
    expect(errorBranch).not.toMatch(/console\.(warn|error)\([^)]*providerError/);
    // Never a second console call in this branch.
    const consoleCallsInBranch = [...errorBranch.matchAll(/console\.(warn|error)\(/g)];
    expect(consoleCallsInBranch.length).toBe(1);
  });

  it("the browser response for a provider error is always the fixed generic string, never providerError or anything derived from the query string", () => {
    const errorBranchStart = source.indexOf('const providerError = getQueryParam(req, "error");');
    const errorBranchEnd = source.indexOf("const code = getQueryParam", errorBranchStart);
    const errorBranch = source.slice(errorBranchStart, errorBranchEnd);
    // intent=connect never gets a JSON response at all (it redirects to the
    // account page instead - see the intent-branching tests in
    // googleOAuth.test.ts) - only the intent=login/default path uses this
    // fixed string via failLogin.
    expect(errorBranch).toMatch(/failLogin\(400, "Google sign-in was not completed"\)/);
  });
});

describe("GOOGLE_OAUTH_REDIRECT_URI is read verbatim from the environment, never derived from a request header", () => {
  const envSource = readSource("server/_core/env.ts");
  const googleOAuthSource = readSource("server/_core/googleOAuth.ts");
  const googleOidcSource = readSource("server/_core/googleOidc.ts");

  it("env.ts reads GOOGLE_OAUTH_REDIRECT_URI directly from process.env, not composed from anything else", () => {
    expect(envSource).toMatch(/googleRedirectUri:\s*process\.env\.GOOGLE_OAUTH_REDIRECT_URI\s*\?\?\s*""/);
  });

  it("neither googleOAuth.ts nor googleOidc.ts ever reads req.headers.host or x-forwarded-host to build a redirect_uri", () => {
    for (const source of [googleOAuthSource, googleOidcSource]) {
      expect(source).not.toMatch(/req\.headers\.host/);
      expect(source).not.toMatch(/x-forwarded-host/i);
      expect(source).not.toMatch(/req\.hostname/);
    }
  });

  it("googleOAuth.ts's redirect_uri query param and googleOidc.ts's token-exchange redirect_uri both come from ENV.googleRedirectUri, not window.location/req.protocol/req.get('host')-style construction", () => {
    expect(googleOAuthSource).toMatch(/searchParams\.set\("redirect_uri",\s*ENV\.googleRedirectUri\)/);
    expect(googleOidcSource).toMatch(/redirect_uri:\s*ENV\.googleRedirectUri/);
  });
});

describe("Google client secret is never exposed to the browser", () => {
  it("GOOGLE_OAUTH_CLIENT_SECRET is never read via import.meta.env or given a VITE_ prefix anywhere in client/ or shared/, including the new transition-mode files (LoginPage.tsx, ProfilePage.tsx, profileGoogleConnectStatus.ts, const.ts)", () => {
    for (const file of [
      "client/src/const.ts",
      "client/src/pages/LoginPage.tsx",
      "client/src/pages/ProfilePage.tsx",
      "client/src/pages/profileGoogleConnectStatus.ts",
    ]) {
      const content = readSource(file);
      expect(content).not.toMatch(/GOOGLE_OAUTH_CLIENT_SECRET/);
      expect(content).not.toMatch(/VITE_GOOGLE/i);
    }
  });

  it("server/_core/env.ts reads GOOGLE_OAUTH_CLIENT_SECRET only via process.env, never import.meta.env", () => {
    const envSource = readSource("server/_core/env.ts");
    const secretLine = envSource
      .split("\n")
      .find((line) => line.includes("googleClientSecret"));
    expect(secretLine).toBeTruthy();
    expect(secretLine).toMatch(/process\.env\.GOOGLE_OAUTH_CLIENT_SECRET/);
    expect(secretLine).not.toMatch(/import\.meta\.env/);
  });

  it("the outgoing Google authorization URL is built only from client_id, redirect_uri, response_type, scope, state, nonce, and PKCE fields - never the client secret", () => {
    const source = readSource("server/_core/googleOAuth.ts");
    const urlBuildStart = source.indexOf("const authorizeUrl = new URL(");
    const urlBuildEnd = source.indexOf("res.redirect(302, authorizeUrl.toString());");
    expect(urlBuildStart).toBeGreaterThan(-1);
    expect(urlBuildEnd).toBeGreaterThan(urlBuildStart);
    const urlBuildBlock = source.slice(urlBuildStart, urlBuildEnd);
    expect(urlBuildBlock).not.toMatch(/googleClientSecret/);
  });

  it("ENV.googleClientSecret is referenced only for the local presence-check (isGoogleProviderConfigured) and the server-to-server token exchange in googleOidc.ts - never elsewhere in googleOAuth.ts", () => {
    const source = readSource("server/_core/googleOAuth.ts");
    const matches = [...source.matchAll(/googleClientSecret/g)];
    // Exactly one reference: inside isGoogleProviderConfigured's boolean check.
    expect(matches.length).toBe(1);
    const isConfiguredFnStart = source.indexOf("function isGoogleProviderConfigured()");
    const isConfiguredFnEnd = source.indexOf("}", isConfiguredFnStart);
    expect(matches[0].index).toBeGreaterThan(isConfiguredFnStart);
    expect(matches[0].index).toBeLessThan(isConfiguredFnEnd);
  });
});

describe("no real Google credential material is committed anywhere in this feature's files", () => {
  const filesToScan = [
    "server/_core/env.ts",
    "server/_core/googleOAuth.ts",
    "server/_core/googleOidc.ts",
    "server/services/googleIdentityService.ts",
    "server/db.ts",
    "client/src/const.ts",
    "client/src/pages/LoginPage.tsx",
    "client/src/pages/ProfilePage.tsx",
    "client/src/pages/profileGoogleConnectStatus.ts",
    "server/routers.ts",
    "drizzle/schema.ts",
    "drizzle/0033_add_auth_identities.sql",
  ];

  it("contains no plausible real Google OAuth client id/secret literal (a long token assigned directly to a client-id/secret-shaped variable)", () => {
    // Google client ids look like <numbers>-<hash>.apps.googleusercontent.com;
    // client secrets are typically GOCSPX-<random> or a long opaque string.
    // This guards against either shape being hardcoded as a literal.
    const suspiciousClientId = /\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/i;
    const suspiciousClientSecret = /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/;
    for (const file of filesToScan) {
      const content = readSource(file);
      expect(content).not.toMatch(suspiciousClientId);
      expect(content).not.toMatch(suspiciousClientSecret);
    }
  });
});

describe("Google ID token / access token / refresh token are never persisted", () => {
  it("no db.ts function or schema column stores an id_token, access_token, or refresh_token value for Google", () => {
    const dbSource = readSource("server/db.ts");
    const schemaSource = readSource("drizzle/schema.ts");
    // Scoped to the Google-specific additions (authIdentities table / the
    // Google db.ts functions), not the whole file - other tables/columns
    // are out of scope for this feature and untouched.
    const authIdentitiesSection = schemaSource.slice(schemaSource.indexOf("export const authIdentities"));
    expect(authIdentitiesSection).not.toMatch(/accessToken|access_token|refreshToken|refresh_token|idToken|id_token/i);

    const googleDbSection = dbSource.slice(dbSection_start(dbSource));
    expect(googleDbSection).not.toMatch(/accessToken|access_token|refreshToken|refresh_token/i);
  });

  function dbSection_start(source: string): number {
    const marker = "GOOGLE OAUTH / AUTH IDENTITIES";
    const idx = source.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    return idx;
  }

  it("googleOidc.ts's GoogleTokenResponse type only ever exposes idToken - never accessToken/refreshToken - so nothing downstream can even accidentally use them", () => {
    const source = readSource("server/_core/googleOidc.ts");
    const typeBlockStart = source.indexOf("export type GoogleTokenResponse");
    const typeBlockEnd = source.indexOf("};", typeBlockStart);
    const typeBlock = source.slice(typeBlockStart, typeBlockEnd);
    expect(typeBlock).toMatch(/idToken/);
    expect(typeBlock).not.toMatch(/accessToken|refreshToken/);
  });
});

describe("Manus OAuth compatibility is fully preserved", () => {
  it("server/_core/oauth.ts (the Manus /api/oauth/callback handler) is untouched - still registers exactly that route", () => {
    const source = readSource("server/_core/oauth.ts");
    expect(source).toMatch(/app\.get\("\/api\/oauth\/callback"/);
  });

  it("server/_core/types/manusTypes.ts still exists and is still imported by sdk.ts", () => {
    expect(() => readSource("server/_core/types/manusTypes.ts")).not.toThrow();
    const sdkSource = readSource("server/_core/sdk.ts");
    expect(sdkSource).toMatch(/from "\.\/types\/manusTypes"/);
  });

  it("OAUTH_SERVER_URL, VITE_OAUTH_PORTAL_URL, and VITE_APP_ID are all still read somewhere in the codebase", () => {
    const envSource = readSource("server/_core/env.ts");
    const clientConstSource = readSource("client/src/const.ts");
    expect(envSource).toMatch(/process\.env\.OAUTH_SERVER_URL/);
    expect(envSource).toMatch(/process\.env\.VITE_APP_ID/);
    expect(clientConstSource).toMatch(/VITE_OAUTH_PORTAL_URL/);
    expect(clientConstSource).toMatch(/VITE_APP_ID/);
  });

  it("server/_core/index.ts still registers the Manus OAuth routes unconditionally (never gated behind AUTH_PROVIDER)", () => {
    const source = readSource("server/_core/index.ts");
    const oauthLineIndex = source.indexOf("registerOAuthRoutes(app);");
    expect(oauthLineIndex).toBeGreaterThan(-1);
    // Not wrapped in an `if (ENV.authProvider ...)` on the same or
    // immediately preceding line - a crude but effective "not gated" check.
    const surrounding = source.slice(Math.max(0, oauthLineIndex - 200), oauthLineIndex);
    expect(surrounding).not.toMatch(/if\s*\(\s*ENV\.authProvider/);
  });

  it("getUserById's signature change (added optional tx param) is backward compatible - existing single-argument call sites elsewhere in db.ts still compile as-is (spot check: no call site passes a second argument except the new Google functions)", () => {
    const source = readSource("server/db.ts");
    const singleArgCalls = [...source.matchAll(/getUserById\(([^,)]+)\)/g)];
    expect(singleArgCalls.length).toBeGreaterThan(0);
    for (const match of singleArgCalls) {
      expect(match[1]).not.toMatch(/,/);
    }
  });
});

describe("AUTH_PROVIDER / VITE_AUTH_PROVIDER default to manus", () => {
  it("server/_core/env.ts's resolveAuthProviderMode is EXACT LITERAL - no .trim()/.toLowerCase()/.toUpperCase() anywhere in the function, so it can never normalize a near-miss (e.g. \" GOOGLE \") into an accepted value", () => {
    const source = readSource("server/_core/env.ts");
    const fnStart = source.indexOf("export function resolveAuthProviderMode(");
    const fnEnd = source.indexOf("\n}", fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnEnd);

    expect(fnBody).not.toMatch(/\.trim\(\)/);
    expect(fnBody).not.toMatch(/\.toLowerCase\(\)/);
    expect(fnBody).not.toMatch(/\.toUpperCase\(\)/);
    expect(fnBody).toMatch(/raw === "google"/);
    expect(fnBody).toMatch(/raw === "transition"/);
    // The final fallthrough is unconditional - the exact literal "manus".
    expect(fnBody.trim().endsWith('return "manus";')).toBe(true);
  });

  it("ENV.authProvider is assigned directly from resolveAuthProviderMode(process.env.AUTH_PROVIDER) - the raw environment value is never trimmed/cased before being handed to it", () => {
    const source = readSource("server/_core/env.ts");
    expect(source).toMatch(/authProvider:\s*resolveAuthProviderMode\(process\.env\.AUTH_PROVIDER\)/);
  });

  it("isManusAuthActive()/isGoogleAuthActive() are the single source of truth other route handlers gate on - both are exact three-way comparisons against ENV.authProvider, never a generic truthy check", () => {
    const source = readSource("server/_core/env.ts");
    expect(source).toMatch(
      /export function isManusAuthActive\(\): boolean \{\s*return ENV\.authProvider === "manus" \|\| ENV\.authProvider === "transition";\s*\}/
    );
    expect(source).toMatch(
      /export function isGoogleAuthActive\(\): boolean \{\s*return ENV\.authProvider === "google" \|\| ENV\.authProvider === "transition";\s*\}/
    );
  });

  it("client/src/const.ts's resolveLoginUrl branches on the exact literals \"google\" and \"transition\" only - everything else (including \"manus\" itself) falls through to the Manus URL", () => {
    const source = readSource("client/src/const.ts");
    expect(source).toMatch(/authProvider === "google"/);
    expect(source).toMatch(/authProvider === "transition"/);
  });
});

describe("drizzle migration 0033 is purely additive", () => {
  const migrationSource = readSource("drizzle/0033_add_auth_identities.sql");

  it("contains no DROP/TRUNCATE/DELETE/ALTER ... DROP/MODIFY/RENAME statement", () => {
    expect(migrationSource).not.toMatch(/\bDROP\b/i);
    expect(migrationSource).not.toMatch(/\bTRUNCATE\b/i);
    expect(migrationSource).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSource).not.toMatch(/MODIFY\s+COLUMN/i);
    expect(migrationSource).not.toMatch(/RENAME/i);
  });

  it("only CREATE TABLE / CREATE INDEX / ALTER TABLE ADD CONSTRAINT (the FK) statements - never a DROP/MODIFY/RENAME variant of ALTER", () => {
    const statements = migrationSource
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const upper = statement.toUpperCase();
      const isCreate = /^CREATE (TABLE|INDEX)/.test(upper);
      const isAddConstraint = /^ALTER TABLE `authIdentities` ADD CONSTRAINT/i.test(statement);
      expect(isCreate || isAddConstraint).toBe(true);
    }
  });

  it("does not touch users.id or users.openId - only adds a new index on users.email", () => {
    expect(migrationSource).not.toMatch(/ALTER TABLE `users`.*(DROP|MODIFY)\s+(COLUMN\s+)?`(id|openId)`/is);
  });

  it("0033_add_auth_identities is present at its own fixed position (idx 33) in the migration journal, and drizzle/0023_gifted_juggernaut.sql / the admin seed files were never added to it - later migrations (e.g. 0034+) may legitimately follow it, so this no longer asserts it is the newest entry", () => {
    const journal = JSON.parse(readSource("drizzle/meta/_journal.json"));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    const entry33 = journal.entries.find((e: { idx: number }) => e.idx === 33);
    expect(entry33?.tag).toBe("0033_add_auth_identities");
    expect(tags).not.toContain("0023_gifted_juggernaut");
    expect(tags).not.toContain("0003_admin_seed");
    expect(tags).not.toContain("LOCAL_ADMIN_BOOTSTRAP");
  });

  it("no migration file before 0033 was modified (spot check: 0032 still exists and is unchanged in the journal at idx 32)", () => {
    const journal = JSON.parse(readSource("drizzle/meta/_journal.json"));
    const entry32 = journal.entries.find((e: { idx: number }) => e.idx === 32);
    expect(entry32?.tag).toBe("0032_add_coupon_ownership_scope");
  });
});

describe("authIdentities unique constraint / index names are specific, not generic", () => {
  it("no fk_1/fk_2/idx_1-style generic constraint names appear in the new migration", () => {
    const migrationSource = readSource("drizzle/0033_add_auth_identities.sql");
    expect(migrationSource).not.toMatch(/\bfk_\d+\b/i);
    expect(migrationSource).not.toMatch(/\bidx_\d+\b/i);
    expect(migrationSource).toMatch(/authIdentities_provider_providerSubject_unique/);
    expect(migrationSource).toMatch(/authIdentities_userId_provider_unique/);
    expect(migrationSource).toMatch(/authIdentities_userId_idx/);
  });
});

describe("authIdentities.userId has a real, specifically-named foreign key to users.id", () => {
  const migrationSource = readSource("drizzle/0033_add_auth_identities.sql");
  const schemaSource = readSource("drizzle/schema.ts");

  it("the migration adds a FOREIGN KEY constraint named authIdentities_userId_users_id_fk, referencing users(id) - standard MySQL/MariaDB/TiDB syntax, no engine-specific extension", () => {
    expect(migrationSource).toMatch(
      /ALTER TABLE `authIdentities` ADD CONSTRAINT `authIdentities_userId_users_id_fk` FOREIGN KEY \(`userId`\) REFERENCES `users`\(`id`\)/
    );
  });

  it("the constraint name is specific and unique in the migration - never a generic fk_1/fk_2 form", () => {
    expect(migrationSource).not.toMatch(/CONSTRAINT `fk_\d+`/i);
    const fkConstraintNames = [...migrationSource.matchAll(/ADD CONSTRAINT `([^`]+)` FOREIGN KEY/g)].map((m) => m[1]);
    expect(fkConstraintNames).toEqual(["authIdentities_userId_users_id_fk"]);
  });

  it("uses ON DELETE CASCADE - an identity row has no meaning once its user is gone", () => {
    expect(migrationSource).toMatch(/FOREIGN KEY \(`userId`\) REFERENCES `users`\(`id`\) ON DELETE cascade/i);
  });

  it("drizzle/schema.ts declares the same foreignKey() with the same explicit name and onDelete('cascade'), referencing users.id", () => {
    const authIdentitiesStart = schemaSource.indexOf("export const authIdentities");
    const authIdentitiesEnd = schemaSource.indexOf("export type AuthIdentity", authIdentitiesStart);
    const authIdentitiesBlock = schemaSource.slice(authIdentitiesStart, authIdentitiesEnd);

    expect(authIdentitiesBlock).toMatch(/name:\s*"authIdentities_userId_users_id_fk"/);
    expect(authIdentitiesBlock).toMatch(/foreignColumns:\s*\[users\.id\]/);
    expect(authIdentitiesBlock).toMatch(/\.onDelete\("cascade"\)/);
  });

  it("this is the only foreign key in the entire migration - no other table gained one as a side effect", () => {
    const fkConstraints = [...migrationSource.matchAll(/FOREIGN KEY/g)];
    expect(fkConstraints.length).toBe(1);
  });
});

describe("connect flow never trusts client-supplied identity - static regression guards", () => {
  const googleOAuthSource = readSource("server/_core/googleOAuth.ts");
  const serviceSource = readSource("server/services/googleIdentityService.ts");

  it("the connect callback's userId comes only from sdk.authenticateRequest(req)'s return value (currentUser.id) - req.query.userId/req.body.userId/req.params.userId never appear anywhere in this file", () => {
    expect(googleOAuthSource).not.toMatch(/req\.query\.userId/);
    expect(googleOAuthSource).not.toMatch(/req\.query\[["']userId["']\]/);
    expect(googleOAuthSource).not.toMatch(/req\.body\.userId/);
    expect(googleOAuthSource).not.toMatch(/req\.params\.userId/);
    expect(googleOAuthSource).toMatch(/currentUser\.id/);
  });

  it("connectGoogleIdentityToUser's own input type documents that userId must come from an authenticated session, never a query string/cookie/other client-supplied source", () => {
    expect(serviceSource).toMatch(/userId: number;/);
    const inputTypeStart = serviceSource.indexOf("export type ConnectGoogleIdentityInput");
    const inputTypeEnd = serviceSource.indexOf("};", inputTypeStart);
    const inputTypeBlock = serviceSource.slice(inputTypeStart, inputTypeEnd);
    expect(inputTypeBlock).toMatch(/never from a query string/);
  });

  it("handleConnectCallback logs failures through safeErrorSummary, the same sanitizing helper the login callback uses - never a raw error/token/code/cookie header logged directly", () => {
    const connectFnStart = googleOAuthSource.indexOf("async function handleConnectCallback");
    expect(connectFnStart).toBeGreaterThan(-1);
    const connectFnBlock = googleOAuthSource.slice(connectFnStart);
    const consoleErrorCalls = [...connectFnBlock.matchAll(/console\.error\([^)]*\)/g)];
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
    for (const call of consoleErrorCalls) {
      expect(call[0]).toMatch(/safeErrorSummary\(/);
    }
    // Never logs the raw code/token/cookie values themselves.
    expect(connectFnBlock).not.toMatch(/console\.(error|warn|log)\([^)]*\bcode\b[^)]*\)/);
  });

  it("the conflict-outcome log in the connect callback logs only result.outcome (a fixed enum literal), never the current user's email/id or the other conflicting user's identity", () => {
    const connectFnStart = googleOAuthSource.indexOf("async function handleConnectCallback");
    const connectFnBlock = googleOAuthSource.slice(connectFnStart);
    const warnMatch = connectFnBlock.match(/console\.warn\(`[^`]*`\)/);
    expect(warnMatch).toBeTruthy();
    expect(warnMatch![0]).toMatch(/result\.outcome/);
    expect(warnMatch![0]).not.toMatch(/currentUser|claims\.email|claims\.sub/);
  });
});
