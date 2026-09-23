import { createHash } from "node:crypto";

export const DATABASE_IDENTITY_PATTERN = /^[0-9a-f]{64}$/i;

export function normalizeDatabaseIdentityFingerprint(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return DATABASE_IDENTITY_PATTERN.test(normalized) ? normalized : undefined;
}

export function databaseIdentityMaterial(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new Error("DATABASE_URL is missing.");
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!["mysql:", "mysql2:", "mariadb:"].includes(url.protocol.toLowerCase())) {
    throw new Error("DATABASE_URL must use a MySQL-compatible protocol.");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !database) {
    throw new Error("DATABASE_URL must include a hostname and database name.");
  }

  const port = url.port || "3306";
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}:${port}/${database}`;
}

export function databaseIdentityFingerprint(databaseUrl) {
  return createHash("sha256")
    .update(databaseIdentityMaterial(databaseUrl), "utf8")
    .digest("hex");
}
