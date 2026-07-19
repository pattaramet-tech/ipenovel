import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { renderSeoHtml } from "../services/serverSeoRenderer";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      let page = await vite.transformIndexHtml(url, template);
      // Server-side <head> metadata for public SEO routes (see
      // server/services/serverSeoRenderer.ts) - runs after Vite's own HTML
      // transform so this is authoritative for what's actually sent.
      // NOTE: req.path would be wrong here - Express rebases req.path
      // relative to a "*" mount point (which consumes the whole path), so
      // it's always "/". req.originalUrl (captured above as `url`) is the
      // real, unmounted-relative request path.
      page = await renderSeoHtml(page, url);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

// Cached once per process, not re-read from disk on every request (this is
// production - the built file never changes without a redeploy, which
// restarts the process anyway).
let cachedProductionTemplate: string | null = null;

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist - this is the SPA
  // route (/, /novels, /novels/:id, ...) response, so it's also where
  // server-side <head> metadata for those routes gets injected (see
  // server/services/serverSeoRenderer.ts). Falls back to the raw,
  // unmodified file via res.sendFile if anything above throws, so a bug in
  // the SEO renderer can never take the whole site down.
  app.use("*", async (req, res) => {
    const indexPath = path.resolve(distPath, "index.html");
    try {
      if (cachedProductionTemplate === null) {
        cachedProductionTemplate = fs.readFileSync(indexPath, "utf-8");
      }
      // req.originalUrl, not req.path - see the matching note in setupVite
      // above (Express rebases req.path to "/" for a "*"-mounted handler).
      const html = await renderSeoHtml(cachedProductionTemplate, req.originalUrl);
      res.status(200).set({ "Content-Type": "text/html" }).send(html);
    } catch (error) {
      console.error("[ServerSEO] Failed to render HTML, falling back to raw file:", error);
      res.sendFile(indexPath);
    }
  });
}
