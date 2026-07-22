import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { storagePut } from "../storage";
import { checkUploadServiceHealth } from "../helpers/uploadHealthCheck";
import { canonicalDomainRedirect } from "./canonicalDomainRedirect";
import { handleSitemapXml } from "./sitemap";
import { ensureDatabaseMigrated } from "./startupMigrations";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

// Procedures that have caused "No procedure found on path ..." client errors
// in production when an older server build was still deployed after the
// client shipped code expecting them. Checked once at boot so a stale
// deploy shows up immediately in server logs instead of only surfacing as a
// confusing client-side runtime error later.
const REQUIRED_TRPC_PROCEDURES = [
  "admin.novels.detail",
  "admin.episodes.list",
  "admin.episodes.detail",
];

function verifyRequiredProcedures() {
  const registered = Object.keys((appRouter as any)._def?.procedures ?? {});
  const missing = REQUIRED_TRPC_PROCEDURES.filter((path) => !registered.includes(path));
  if (missing.length > 0) {
    console.error(
      `[Router Check] MISSING tRPC procedure(s): ${missing.join(", ")}. ` +
      `This server build is likely stale - Sync from GitHub and redeploy from the latest commit on main.`
    );
  } else {
    console.log(`[Router Check] OK - ${REQUIRED_TRPC_PROCEDURES.length} required admin procedures present (${registered.length} total).`);
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // STEP 1-3: environment is loaded by `import "dotenv/config"` at the top of
  // this file; migrations and the post-migration read-only schema
  // verification both run here, inside scripts/migrate.mjs. Nothing below
  // this line may execute unless that succeeded - in particular no Express
  // app is constructed and no port is opened. This is what makes a direct
  // `node dist/index.js` start (bypassing package.json, as the hosting
  // platform did during the incident) safe.
  await ensureDatabaseMigrated();

  // STEP 4: construct the Express application.
  const app = express();
  // Trust the first hop reverse proxy (e.g. Manus production) so Express
  // reads X-Forwarded-Proto/-For correctly - without this, req.protocol
  // always reports the proxy's plain-HTTP connection to this process, so
  // isSecureRequest()'s req.protocol === "https" check in cookies.ts can
  // never be true even when the client is genuinely on HTTPS.
  app.set("trust proxy", 1);
  const server = createServer(app);
  // Canonical domain redirect (old Manus subdomain -> ipenovel.com) - must
  // run before body parsers/routes so a redirected request does no
  // unnecessary work, and after `trust proxy` so it agrees with the rest of
  // the app about the real client-facing host/protocol.
  app.use(canonicalDomainRedirect);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Dynamic sitemap (published novels only) - must be registered before the
  // Vite/static-file fallback below, otherwise /sitemap.xml would 404 and
  // fall through to the SPA's index.html instead of returning XML.
  app.get("/sitemap.xml", handleSitemapXml);

  // REMOVED: /api/upload endpoint
  // Use tRPC payment.uploadSlipFile instead for consistent validation and error handling
  // This endpoint was removed to prevent unauthenticated file uploads and enforce proper validation
  
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  verifyRequiredProcedures();
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Check upload service health
    checkUploadServiceHealth();
  });
}

// Fail closed. The previous `startServer().catch(console.error)` logged the
// raw error (which for a database failure can embed SQL and connection
// details) and still let the process exit 0, so a hosting platform saw a
// "clean" exit after a failed startup. Now the summary is sanitized and the
// exit status is always non-zero, so a failed migration can never be
// mistaken for a successful boot.
//
// process.exitCode (rather than process.exit) lets Node flush stdio and
// exit naturally - at this point the server never called listen(), so
// nothing is holding the event loop open.
startServer().catch((error: unknown) => {
  console.error(`[startup] FATAL: server did not start: ${safeErrorSummary(error)}`);
  process.exitCode = 1;
});
