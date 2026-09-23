import fs from "node:fs";
import path from "node:path";

export const PREVIEW_HOST = "r2-preview.ipenovel.com";
export const PRODUCTION_STAGING_HOST = "production-staging.ipenovel.com";
const SAFE_HOSTS = new Set([
  PREVIEW_HOST,
  PRODUCTION_STAGING_HOST,
  "localhost",
  "127.0.0.1",
]);

export const e2eBaseUrl =
  process.env.E2E_BASE_URL?.trim() || `https://${PREVIEW_HOST}`;

export const authStatePath = path.resolve(
  process.env.E2E_STORAGE_STATE?.trim() || ".playwright/.auth/user.json"
);

export const adminAuthStatePath = path.resolve(
  process.env.E2E_ADMIN_STORAGE_STATE?.trim() || ".playwright/.auth/admin.json"
);

export const hasAuthState = fs.existsSync(authStatePath);
export const hasAdminAuthState = fs.existsSync(adminAuthStatePath);
export const mutationEnabled = /^(1|true|yes)$/i.test(
  process.env.E2E_ALLOW_MUTATION?.trim() || ""
);
export const novelIdentifier =
  process.env.E2E_NOVEL_IDENTIFIER?.trim() || "4050013";

export const packageLabel =
  process.env.E2E_PACKAGE_LABEL?.trim() || "036 - 085";

export const freeEpisodeId =
  process.env.E2E_FREE_EPISODE_ID?.trim() || "7950192";

export function assertSafeE2ETarget(rawUrl = e2eBaseUrl): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid E2E_BASE_URL: ${rawUrl}`);
  }

  if (!SAFE_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing Playwright target "${url.hostname}". ` +
        `Allowed hosts: ${[...SAFE_HOSTS].join(", ")}.`
    );
  }
}
export function mutationSkipReason(): string | undefined {
  if (!hasAuthState) {
    return `Authenticated state not found at ${authStatePath}. Run test:e2e:auth:capture first.`;
  }
  if (!mutationEnabled) {
    return "Mutation regression is disabled. Set E2E_ALLOW_MUTATION=1 for Preview.";
  }
  return undefined;
}
