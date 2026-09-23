import process from "node:process";
import { databaseIdentityFingerprint } from "./lib/databaseIdentity.mjs";

try {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  console.log(databaseIdentityFingerprint(databaseUrl));
} catch (error) {
  console.error(`[database-identity] FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
