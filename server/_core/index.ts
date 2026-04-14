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
import { getHealthStatus, getReadinessStatus, logStartupInfo, logStartupWarnings } from "./healthCheck";
import { validateEnvironment } from "./env";
import { sdk } from "./sdk";
import downloadRoute from "../routes/downloadRoute";

/**
 * Find an available port for local development.
 * Scans starting from the given port up to +20 ports.
 * Only used in development mode.
 */
function findAvailablePortForDev(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port >= startPort + 20) {
        reject(new Error(`No available port found starting from ${startPort}`));
        return;
      }
      
      const server = net.createServer();
      server.listen(port, () => {
        server.close(() => resolve(port));
      });
      server.on("error", () => tryPort(port + 1));
    };
    
    tryPort(startPort);
  });
}

async function startServer() {
  // Validate all required environment variables
  validateEnvironment();
  
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Log startup information
  logStartupInfo();
  logStartupWarnings();
  
  // Health and readiness check endpoints (must be before tRPC middleware)
  app.get("/health", async (req, res) => {
    try {
      const health = await getHealthStatus();
      const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 503 : 500;
      res.status(statusCode).json(health);
    } catch (error) {
      console.error("Health check error:", error);
      res.status(500).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: 0,
        checks: { database: "failed", memory: "critical" },
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/readiness", async (req, res) => {
    try {
      const readiness = await getReadinessStatus();
      const statusCode = readiness.ready ? 200 : 503;
      res.status(statusCode).json(readiness);
    } catch (error) {
      console.error("Readiness check error:", error);
      res.status(500).json({
        ready: false,
        timestamp: new Date().toISOString(),
        checks: { database: false, environment: false },
        errors: [error instanceof Error ? error.message : "Unknown error"]
      });
    }
  });
  
  // Authentication middleware for protected routes
  app.use(async (req, res, next) => {
    try {
      const user = await sdk.authenticateRequest(req);
      (req as any).user = user;
    } catch (error) {
      // User not authenticated, continue (routes will handle auth as needed)
    }
    next();
  });
  
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  
  // Download route for secure file access
  app.use("/api", downloadRoute);
  
  // File upload endpoint for payment slips
  // SECURITY: Requires authentication to prevent abuse
  app.post("/api/upload", async (req, res) => {
    try {
      // Authenticate user
      let user;
      try {
        user = await sdk.authenticateRequest(req);
      } catch (error) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { file, filename, type } = req.body;
      
      if (!file || !filename) {
        return res.status(400).json({ error: "Missing file or filename" });
      }
      
      // Validate file type
      const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: "Invalid file type" });
      }
      
      // Sanitize filename to prevent path injection
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      
      // Convert base64 to buffer
      const base64Data = file.split(",")[1] || file;
      const buffer = Buffer.from(base64Data, "base64");
      
      // Magic-byte validation to prevent fake file uploads
      const magicBytes = buffer.slice(0, 4);
      const isValidJpeg = magicBytes[0] === 0xff && magicBytes[1] === 0xd8 && magicBytes[2] === 0xff;
      const isPng = magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4e && magicBytes[3] === 0x47;
      const isPdf = magicBytes[0] === 0x25 && magicBytes[1] === 0x50 && magicBytes[2] === 0x44 && magicBytes[3] === 0x46;
      
      if (type === "image/jpeg" && !isValidJpeg) {
        return res.status(400).json({ error: "Invalid JPEG file" });
      }
      if (type === "image/png" && !isPng) {
        return res.status(400).json({ error: "Invalid PNG file" });
      }
      if (type === "application/pdf" && !isPdf) {
        return res.status(400).json({ error: "Invalid PDF file" });
      }
      
      // Validate file size (max 5MB)
      if (buffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large" });
      }
      
      // Upload to S3 with user ID in path for organization
      const fileKey = `payment-slips/${user.id}/${Date.now()}-${sanitizedFilename}`;
      const { url } = await storagePut(fileKey, buffer, type);
      
      res.json({ url });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  });
  
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Determine port based on environment
  let port: number;
  
  if (process.env.NODE_ENV === "production") {
    // Production: Bind directly to PORT env var (must be set by PaaS)
    // No probing, no fallback, no scanning - fail fast if invalid
    if (!process.env.PORT) {
      throw new Error("PORT environment variable is required in production");
    }
    
    port = parseInt(process.env.PORT, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid PORT environment variable: "${process.env.PORT}". Must be a number between 1 and 65535.`);
    }
    
    console.log(`[Production] Binding to port ${port}`);
  } else {
    // Development: Use PORT env var if set, otherwise default to 3000
    // Scan for available port if needed
    const preferredPort = parseInt(process.env.PORT || "3000", 10);
    if (isNaN(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
      throw new Error(`Invalid PORT environment variable: "${process.env.PORT}". Must be a number between 1 and 65535.`);
    }
    
    port = await findAvailablePortForDev(preferredPort);
    
    if (port !== preferredPort) {
      console.log(`[Development] Port ${preferredPort} is busy, using port ${port} instead`);
    }
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
