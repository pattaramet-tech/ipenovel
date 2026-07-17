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
  const app = express();
  // Trust the first hop reverse proxy (e.g. Manus production) so Express
  // reads X-Forwarded-Proto/-For correctly - without this, req.protocol
  // always reports the proxy's plain-HTTP connection to this process, so
  // isSecureRequest()'s req.protocol === "https" check in cookies.ts can
  // never be true even when the client is genuinely on HTTPS.
  app.set("trust proxy", 1);
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  
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

startServer().catch(console.error);
