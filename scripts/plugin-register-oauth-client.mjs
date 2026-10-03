#!/usr/bin/env node
// IPE-PLUGIN-001B operator tool: register one plugin OAuth client.
//
// Usage:
//   node scripts/plugin-register-oauth-client.mjs \
//     --name "ChatGPT Connector" \
//     --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect" \
//     [--redirect-uri "..."] \
//     [--client-id my-connector] \
//     [--scopes "identity:read workspace:read novel:read pack:read chapter:read"]
//
// Prints the clientId + client secret ONCE (the secret is stored only as a
// sha256 hash) and exits. Requires DATABASE_URL. Run the migrations first
// (pnpm db:migrate) so the plugin tables exist.

import { createHash, randomBytes } from "node:crypto";
import mysql from "mysql2/promise";

function parseArgs(argv) {
  const args = { name: undefined, redirectUris: [], clientId: undefined, scopes: "identity:read" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") args.name = argv[++i];
    else if (arg === "--redirect-uri") args.redirectUris.push(argv[++i]);
    else if (arg === "--client-id") args.clientId = argv[++i];
    else if (arg === "--scopes") args.scopes = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.name || args.redirectUris.length === 0) {
  console.error("--name and at least one --redirect-uri are required");
  process.exit(1);
}

const SERVER_ALLOWED_SCOPES = ["identity:read", "workspace:read", "novel:read", "pack:read", "chapter:read"];
const requestedScopes = (args.scopes ?? "").split(/\s+/).filter(Boolean);
const unknownScopes = requestedScopes.filter(scope => !SERVER_ALLOWED_SCOPES.includes(scope));
if (unknownScopes.length > 0 || requestedScopes.length === 0) {
  console.error(`--scopes must be a non-empty subset of: ${SERVER_ALLOWED_SCOPES.join(" ")}`);
  process.exit(1);
}
for (const uri of args.redirectUris) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    console.error(`--redirect-uri is not an absolute URL: ${uri}`);
    process.exit(1);
  }
  const isLoopbackHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    console.error(`--redirect-uri must be https (or http loopback): ${uri}`);
    process.exit(1);
  }
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const url = new URL(dbUrl);
let ssl = false;
const sslParam = url.searchParams.get("ssl");
if (sslParam) {
  try {
    ssl = JSON.parse(sslParam);
  } catch {
    ssl = true;
  }
}

const connection = await mysql.createConnection({
  host: url.hostname,
  port: url.port,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl,
});

const clientId = args.clientId || `plg_${randomBytes(12).toString("hex")}`;
const clientSecret = randomBytes(32).toString("base64url");
const clientSecretHash = createHash("sha256").update(clientSecret).digest("hex");

try {
  await connection.execute(
    `INSERT INTO pluginOAuthClients (clientId, clientSecretHash, name, redirectUris, allowedScopes, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
    [clientId, clientSecretHash, args.name, JSON.stringify(args.redirectUris), requestedScopes.join(" ")]
  );
  console.log("✅ Plugin OAuth client registered");
  console.log("clientId:", clientId);
  console.log("clientSecret:", clientSecret);
  console.log("(shown once - stored only as a sha256 hash)");
  console.log("redirectUris:", JSON.stringify(args.redirectUris));
  console.log("allowedScopes:", requestedScopes.join(" "));
} catch (error) {
  if (error && error.code === "ER_DUP_ENTRY") {
    console.error("❌ clientId already exists:", clientId);
  } else {
    console.error("❌ Failed to register client:", error?.message ?? error);
  }
  process.exit(1);
} finally {
  await connection.end();
}
